import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import type { Config } from '../../../types/reely';
import { logger } from './logger';
import { createWsUpgradeHandler } from './handlers/api';
import { handler as basicAuthHandler } from './handlers/basic_auth';
import { handler as healthHandler } from './handlers/health';
import { handler as posterHandler } from './handlers/poster';
import { handler as serveStaticHandler } from './handlers/serve_static';
import { handler as templateHandler } from './handlers/template';
import { rateLimit } from './middleware/rateLimit';
import { createProvider as createPlexProvider } from './providers/plex';
import type { ReelyProvider } from './providers/types';
import { Client } from './client';
import { cleanupExpiredRooms, flushPendingSaves, ROOM_TTL_MS } from './roomStore';

export class ProviderUnavailableError extends Error {}

export interface ApplicationInstance {
  statusCode: Promise<number | undefined>;
}

// Every spelling Node accepts (or reports from address()) for "bind every
// interface". A falsy host means the same thing and is handled separately.
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '::0', '[::]', '::ffff:0.0.0.0', '0']);

// String(err) drops Error.cause, and that is exactly where the Plex client
// parks the real reason (ECONNREFUSED, ENOTFOUND, an abort on timeout), so an
// operator debugging a failed start would otherwise get the wrapper message
// and nothing else. Depth-bounded so a self-referential cause can't spin.
export const describeError = (err: unknown): string => {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    parts.push(String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': caused by ');
};

export const Application = (config: Config, signal?: AbortSignal): ApplicationInstance => {
  // statusCode: undefined = clean shutdown via abort signal, number = exit
  // code. Rejects with ProviderUnavailableError so main.ts can log that case.
  const statusCode = new Promise<number | undefined>((resolveStatus, rejectStatus) => {
    (async () => {
      // Wired before the first await. The full shutdown() doesn't exist until
      // the server is listening, and an abort dispatched before then would be
      // dropped: EventTarget only calls listeners present at abort time, so a
      // `docker stop` during a slow Plex probe used to be ignored entirely and
      // the container ran on until SIGKILL. Until the real handler replaces
      // it, an abort just raises a flag the startup path checks.
      let abortRequested = signal?.aborted ?? false;
      let onAbort = () => { abortRequested = true; };
      signal?.addEventListener('abort', () => { onAbort(); });

      // Returns true when startup should stop. Resolving undefined is the
      // clean-shutdown contract: nothing is listening and nothing was queued.
      const abortedDuringStartup = (): boolean => {
        if (!abortRequested) return false;
        logger.info('Abort signal received during startup. Server not started.');
        resolveStatus(undefined);
        return true;
      };
      if (abortedDuringStartup()) return;

      // Read TLS cert + key FIRST so a bad path fails before the TTL sweep,
      // the Plex probe and the middleware mounts run. Buffers re-used below.
      let tlsBundle: { cert: Buffer; key: Buffer } | undefined;
      if (config.tlsConfig) {
        const [cert, key] = await Promise.all([
          readFile(config.tlsConfig.certFile),
          readFile(config.tlsConfig.keyFile),
        ]);
        tlsBundle = { cert, key };
        if (abortedDuringStartup()) return;
      }

      // Sweep at startup so a restart after downtime clears stale rooms at
      // once instead of waiting for the periodic sweep.
      await cleanupExpiredRooms(ROOM_TTL_MS);
      if (abortedDuringStartup()) return;

      const providers: ReelyProvider[] = [];

      // Single-server by design. `servers` stays an array (and the `[0]`
      // indexing with it) so multi-PROVIDER can land later without a
      // wire-format change; multi-server is not supported.
      if (config.servers.length > 0) {
        if (config.servers.length > 1) {
          logger.warn(
            `${config.servers.length} servers configured; reely supports one server. Only the first will be used.`,
          );
        }
        const serverConfig = config.servers[0];
        if (typeof serverConfig.type === 'string' && serverConfig.type !== 'plex') {
          throw new Error(`server type ${serverConfig.type} unhandled.`);
        }
        providers.push(createPlexProvider('0', serverConfig));

        for (const provider of providers) {
          // isAvailable() only returns false when Plex answers but the payload
          // is unrecognisable; a refused connection, a bad host, a timeout or a
          // rejected token all throw. Catching here keeps every one of those on
          // the tailored "Plex server unavailable" path instead of the generic
          // startup-error path, which is what the operator needs to see.
          //
          // The URL is logged whole, not sliced: the redaction registry holds
          // the full literal and only replaces exact substrings, so a truncated
          // copy printed unmasked while a short one was masked.
          let available = false;
          let probeError: unknown;
          try {
            available = await provider.isAvailable();
          } catch (err) {
            probeError = err;
          }
          if (!available) {
            throw new ProviderUnavailableError(
              `Plex server unavailable: ${provider.options.url}`,
              { cause: probeError },
            );
          }
        }
        if (abortedDuringStartup()) return;
      }

      const app = express();
      // Explicit no-proxy assumption. Enabling `trust proxy` makes `req.ip`
      // follow X-Forwarded-For, which opens IP spoofing via headers.
      app.disable('trust proxy');
      // Per-request access logs deliberately not wired: 429 and 401 already
      // log explicitly, so the gap is 2xx/3xx noise.

      // The browser probes `${plexBaseUrl}/identity` to decide between a direct
      // LAN link and app.plex.tv. That fetch leaves this origin, so 'self'
      // alone makes CSP block it before it is sent and the probe fails every
      // time, permanently disabling the LAN branch. Only the origin already
      // shipped to the browser in the config frame is allowed, so this
      // discloses nothing new; withholding the URL withholds the exception too.
      const connectSrc = ["'self'"];
      if (config.exposePlexBaseUrl !== false && config.servers.length > 0) {
        try {
          connectSrc.push(new URL(config.servers[0].url).origin);
        } catch {
          // Validation rejects a scheme-less URL, so this is unreachable in a
          // booted config; leave connect-src at 'self' rather than throwing.
        }
      }

      // useDefaults:false because helmet's default CSP adds
      // `upgrade-insecure-requests`, which breaks plain-http LAN serving.
      //
      // script-src 'self': no inline scripts in the production build.
      // style-src needs 'unsafe-inline' for React style={{...}}.
      // connect-src 'self' covers the same-origin WebSocket.
      app.use(helmet({
        contentSecurityPolicy: {
          useDefaults: false,
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            fontSrc: ["'self'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc,
            workerSrc: ["'self'"],
            manifestSrc: ["'self'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
          },
        },
      }));

      // Gzip the SPA shell and static assets. Skip /api/poster: gzipping
      // already-compressed JPEGs only burns CPU.
      app.use(compression({
        filter: (req, res) => {
          if (req.path.startsWith('/api/poster/')) return false;
          return compression.filter(req, res);
        },
      }));

      // Inject providers into res.locals for downstream route handlers.
      app.use((_req, res, next) => { res.locals.providers = providers; next(); });

      // Per-route per-IP limits: loose enough for poster fan-out on room join
      // and healthcheck polling, tight enough to short-circuit a flood.
      //
      // Poster headroom is deliberately large: the bucket is keyed on the
      // client address, which collapses a whole IPv6 /64 (one household) into
      // one counter, and both match surfaces render an <img> per match, so the
      // per-minute ceiling has to clear a long shortlist being scrolled while
      // the deck is also pulling card art. A 429 there leaves a blank tile
      // with no retry.
      const healthLimit   = rateLimit({ windowMs: 60_000, max: 60,   name: 'health' });
      const posterLimit   = rateLimit({ windowMs: 60_000, max: 2000, name: 'poster' });
      const templateLimit = rateLimit({ windowMs: 60_000, max: 60,   name: 'template' });

      app.get('/health', healthLimit, healthHandler);
      app.use(basicAuthHandler);
      app.get('/api/poster/:providerIndex/:metadataId/:thumbId', posterLimit, posterHandler);
      app.use(serveStaticHandler);
      // Express 5 rejects the bare '*' catch-all; '/{*splat}' is the spelling
      // that matches '/' and every deeper path.
      app.get('/{*splat}', templateLimit, templateHandler);

      // Terminal error handler for rejected async handlers. Without it
      // finalhandler console.error()s the stack past the redacting logger and,
      // outside production, echoes filesystem paths into the 500 body.
      // The unused `next` must stay: 4-arity is what marks error middleware.
      app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        // Non-Error rejections have no .stack/.message; String() still logs.
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        logger.error(`Unhandled handler error: ${detail}`);
        if (!res.headersSent) res.status(500).send('Internal Server Error');
        else res.destroy();
      });

      // Underlying http/https server, so the WS upgrade listener can attach.
      const httpServer: ReturnType<typeof createHttpServer> = tlsBundle
        ? createHttpsServer({ cert: tlsBundle.cert, key: tlsBundle.key }, app)
        : createHttpServer(app);

      const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });

      // Per-socket liveness tag, cast in rather than extending the ws type
      // globally.
      type LivenessTagged = { isAlive?: boolean };

      wss.on('connection', (ws) => {
        (ws as unknown as LivenessTagged).isAlive = true;
        ws.on('pong', () => {
          (ws as unknown as LivenessTagged).isAlive = true;
        });
        // Client manages its own lifecycle.
        new Client(ws, providers);
      });

      httpServer.on('upgrade', createWsUpgradeHandler(wss));

      await new Promise<void>((resolveListening, rejectListening) => {
        httpServer.listen(config.port, config.hostname, () => {
          const proto = config.tlsConfig ? 'https' : 'http';
          // Rooms are gated only by knowing the room name, so binding to all
          // interfaces without Basic Auth is effectively no gate at all.
          //
          // Ask the socket what it bound rather than trusting the configured
          // string: listen() treats any falsy host as "bind everything", so a
          // bare `hostname:` line in config.yaml (null to js-yaml) silenced
          // this warning while the server sat on every interface.
          const bound = httpServer.address();
          const boundHost = typeof bound === 'object' && bound !== null ? bound.address : undefined;
          const listenHost = boundHost || config.hostname;
          logger.info(`Server listening on ${proto}://${listenHost || '0.0.0.0'}:${config.port}`);
          const bindsAllInterfaces = !listenHost || WILDCARD_HOSTS.has(listenHost);
          if (bindsAllInterfaces && !config.basicAuth) {
            logger.warn(
              `Bound to ${listenHost || '0.0.0.0'} without Basic Auth. ` +
              'Anyone who can route to this host can join or create rooms. ' +
              'Set basicAuth in your config (or only expose this port to your LAN/VPN) to gate access.',
            );
          }
          resolveListening();
        });
        httpServer.once('error', rejectListening);
      });

      // The listen guard above is a `once`, so the first error after startup
      // consumes it on an already-settled promise (a silent no-op) and the
      // next one escapes an emitter with no 'error' handler, which Node turns
      // into an uncaught throw. A standing listener keeps accept-time failures
      // (EMFILE and friends) visible and non-fatal.
      httpServer.on('error', (err) => {
        logger.error(`HTTP server error: ${describeError(err)}`);
      });

      // Keep sockets alive through idle-closing reverse proxies, and terminate
      // zombies that missed the previous ping. Created after listen() succeeds:
      // a listen failure throws past the only code that clears the interval.
      const pingInterval = setInterval(() => {
        for (const ws of wss.clients) {
          const tagged = ws as unknown as LivenessTagged;
          if (tagged.isAlive === false) {
            logger.info('Terminating unresponsive WebSocket (missed pong)');
            ws.terminate();
            continue;
          }
          tagged.isAlive = false;
          if (ws.readyState === ws.OPEN) ws.ping();
        }
      }, 30_000);

      // Periodic TTL sweep. 10 minutes keeps expiry timely and the disk scan
      // cost trivial.
      const ttlSweepInterval = setInterval(() => {
        cleanupExpiredRooms(ROOM_TTL_MS).catch((err) => {
          logger.error(`TTL sweep failed: ${String(err)}`);
        });
      }, 10 * 60 * 1000);

      // Idempotent shutdown; the flag is per-Application, not module-global.
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info('Shutting down...');
        clearInterval(pingInterval);
        clearInterval(ttlSweepInterval);
        // Stop accepting frames BEFORE draining. flushPendingSaves snapshots
        // the queue and then awaits real disk I/O; with the sockets still open
        // the event loop keeps dispatching swipes through that window, and each
        // one arms a debounce timer in a queue the departed flush will never
        // look at again. Those ratings were lost at process.exit.
        //
        // wss.close() only stops new connections and httpServer.close() waits
        // for every socket to end, so terminate WS clients and drop lingering
        // HTTP sockets or the close callback hangs on a slow poster stream.
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        // Now that nothing can queue another save, drain what is queued:
        // pending timers are orphaned once the process exits, losing any swipe
        // still inside the debounce window.
        await flushPendingSaves();
        httpServer.close(() => {
          logger.info('Server closed.');
          resolveStatus(undefined);
        });
        httpServer.closeAllConnections();
      };

      // Hand the abort over to the real shutdown now that one exists.
      onAbort = () => {
        logger.info('Abort signal received. Closing server.');
        // Fire-and-forget: the listener can't await. shutdown() guards re-entry.
        void shutdown();
      };
      // An abort raised between the last startup check and the handover above
      // only set the flag, so act on it here. Without this a stop late in boot
      // is ignored: the server runs until SIGKILL and never flushes saves.
      if (abortRequested) void shutdown();
    })().catch((err) => {
      // ProviderUnavailableError flows up to main.ts for its own message;
      // everything else is a generic startup-error exit.
      if (err instanceof ProviderUnavailableError) {
        rejectStatus(err);
        return;
      }
      logger.error(`Application startup error: ${describeError(err)}`);
      resolveStatus(1);
    });
  });

  return { statusCode };
};
