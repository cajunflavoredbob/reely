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

export const Application = (config: Config, signal?: AbortSignal): ApplicationInstance => {
  // statusCode: undefined = clean shutdown via abort signal, number = exit
  // code. Rejects with ProviderUnavailableError so main.ts can log that case.
  const statusCode = new Promise<number | undefined>((resolveStatus, rejectStatus) => {
    (async () => {
      // Read TLS cert + key FIRST so a bad path fails before the TTL sweep,
      // the Plex probe and the middleware mounts run. Buffers re-used below.
      let tlsBundle: { cert: Buffer; key: Buffer } | undefined;
      if (config.tlsConfig) {
        const [cert, key] = await Promise.all([
          readFile(config.tlsConfig.certFile),
          readFile(config.tlsConfig.keyFile),
        ]);
        tlsBundle = { cert, key };
      }

      // Sweep at startup so a restart after downtime clears stale rooms at
      // once instead of waiting for the periodic sweep.
      await cleanupExpiredRooms(ROOM_TTL_MS);

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
          if (!await provider.isAvailable()) {
            throw new ProviderUnavailableError(
              `Plex server unavailable: ${provider.options.url.substring(0, 32)}`,
            );
          }
        }
      }

      const app = express();
      // Explicit no-proxy assumption. Enabling `trust proxy` makes `req.ip`
      // follow X-Forwarded-For, which opens IP spoofing via headers.
      app.disable('trust proxy');
      // Per-request access logs deliberately not wired: 429 and 401 already
      // log explicitly, so the gap is 2xx/3xx noise.

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
            connectSrc: ["'self'"],
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
      const healthLimit   = rateLimit({ windowMs: 60_000, max: 60,  name: 'health' });
      const posterLimit   = rateLimit({ windowMs: 60_000, max: 600, name: 'poster' });
      const templateLimit = rateLimit({ windowMs: 60_000, max: 60,  name: 'template' });

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
          logger.info(`Server listening on ${proto}://${config.hostname}:${config.port}`);
          // Rooms are gated only by knowing the room name, so binding to all
          // interfaces without Basic Auth is effectively no gate at all.
          const bindsAllInterfaces =
            config.hostname === '0.0.0.0' || config.hostname === '::' || config.hostname === '';
          if (bindsAllInterfaces && !config.basicAuth) {
            logger.warn(
              `Bound to ${config.hostname || '0.0.0.0'} without Basic Auth. ` +
              'Anyone who can route to this host can join or create rooms. ' +
              'Set basicAuth in your config (or only expose this port to your LAN/VPN) to gate access.',
            );
          }
          resolveListening();
        });
        httpServer.once('error', rejectListening);
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
        // Drain the save queue first: pending timers are orphaned once the
        // process exits, losing any swipe still inside the debounce window.
        await flushPendingSaves();
        // wss.close() only stops new connections and httpServer.close() waits
        // for every socket to end, so terminate WS clients and drop lingering
        // HTTP sockets or the close callback hangs on a slow poster stream.
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        httpServer.close(() => {
          logger.info('Server closed.');
          resolveStatus(undefined);
        });
        httpServer.closeAllConnections();
      };

      signal?.addEventListener('abort', () => {
        logger.info('Abort signal received. Closing server.');
        // Fire-and-forget: the listener can't await. shutdown() guards re-entry.
        void shutdown();
      });
      // An abort during async startup fires before the listener above exists,
      // and an already-aborted signal never invokes listeners added later.
      // Without this check a stop mid-boot is ignored: the server finishes
      // starting, runs until SIGKILL, and never flushes pending saves.
      if (signal?.aborted) void shutdown();
    })().catch((err) => {
      // ProviderUnavailableError flows up to main.ts for its own message;
      // everything else is a generic startup-error exit.
      if (err instanceof ProviderUnavailableError) {
        rejectStatus(err);
        return;
      }
      logger.error(`Application startup error: ${String(err)}`);
      resolveStatus(1);
    });
  });

  return { statusCode };
};
