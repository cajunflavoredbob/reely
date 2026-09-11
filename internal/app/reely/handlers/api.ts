import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { WebSocketServer } from 'ws';
import { logger } from '../logger';
import { clientKey } from '../util/clientKey';
import { getConfig } from '../config/main';
import { checkBasicAuth } from './basic_auth';
import {
  authFailureRetryAfter,
  recordAuthFailure,
} from '../middleware/authFailureThrottle';

// Reduces a configured or received origin to its canonical serialization, or
// undefined if it isn't one. Operators copy origins out of a browser address
// bar, which appends a trailing slash, and host case is not significant: a raw
// string compare turns either spelling into a 403 on every handshake, under a
// log line telling the operator to set the variable they already set.
// A URL with no real origin (file:, data:) serializes to "null", which must
// never match anything.
const normalizeOrigin = (value: string): string | undefined => {
  try {
    const { origin } = new URL(value);
    return origin === 'null' ? undefined : origin.toLowerCase();
  } catch {
    return undefined;
  }
};

// Cross-Site WebSocket Hijacking guard. Browsers always send Origin on a WS
// handshake; non-browser clients (no CSWSH risk) send none. Allowed when Origin
// is absent, matches the request Host, or is listed in ALLOWED_ORIGINS.
// Compares against the request Host because reely has no configured hostname.
// That stops CSWSH, not DNS rebinding: accepted here, since no secret reaches
// the browser and a proxy is the answer for stricter control.
export const isOriginAllowed = (req: IncomingMessage): boolean => {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  // Host comparison is case-insensitive per RFC 7230; a proxy may forward
  // mixed case.
  const reqHost = req.headers.host;
  if (
    typeof reqHost === 'string' &&
    originHost.toLowerCase() === reqHost.toLowerCase()
  ) return true;
  const configured = getConfig().allowedOrigins;
  // The env loader always produces a list, but the natural YAML spelling
  // (`allowedOrigins: https://example.com`) is a scalar. Accept it rather than
  // silently ignoring a config that reads as correct.
  const allowed: readonly string[] | undefined =
    typeof configured === 'string' ? [configured] : configured;
  if (!Array.isArray(allowed)) return false;
  const candidate = normalizeOrigin(origin);
  if (!candidate) return false;
  return allowed.some((entry) => normalizeOrigin(entry) === candidate);
};

// The per-connection WS message limit caps volume per socket, so without this
// one IP could open hundreds of sockets and multiply it. Generous enough for a
// household behind NAT.
//
// Behind a reverse proxy the peer address is the proxy, so every client shares
// one key and this becomes a whole-deployment ceiling of 20 concurrent
// sockets. Unlike the counting limiters, which only slow a shared source down,
// this one refuses connections outright: a large deployment behind a proxy
// needs this number raised.
const MAX_WS_PER_IP = 20;
// Bounds the tracking Map itself: a flood of distinct source addresses would
// otherwise grow it without limit. Far above any realistic deployment.
const MAX_WS_IPS = 1000;
const wsConnectionsByIp = new Map<string, number>();

export const createWsUpgradeHandler = (wss: WebSocketServer) =>
  (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    // split, not `new URL`: this runs on every upgrade including failed
    // handshakes, so the allocation matters under flood.
    const pathname = (req.url ?? '').split('?')[0];
    if (pathname !== '/api/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isOriginAllowed(req)) {
      logger.warn(
        `WebSocket upgrade rejected: disallowed Origin "${req.headers.origin}". ` +
        'Set ALLOWED_ORIGINS if this is a legitimate reverse-proxy origin.',
      );
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Grouped, not raw (see util/clientKey): a raw IPv6 address makes the
    // per-IP cap and the auth throttle trivially bypassable, and floods the
    // tracking Map until its size cap locks out every untracked source.
    const ip = clientKey(socket.remoteAddress);
    const config = getConfig();
    if (config.basicAuth) {
      // Shares a budget with the HTTP middleware so switching vectors doesn't
      // reset the counter. Runs before the credential compare so a throttled IP
      // can't keep guessing through unmetered handshakes.
      const retryAfter = authFailureRetryAfter(ip);
      if (retryAfter > 0) {
        logger.warn(
          `WebSocket upgrade rejected: ${ip} throttled after repeated Basic Auth failures.`,
        );
        socket.write(
          `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${retryAfter}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      if (!checkBasicAuth(config.basicAuth, req.headers.authorization)) {
        recordAuthFailure(ip);
        logger.warn('WebSocket upgrade rejected: missing or invalid Basic Auth credentials.');
        socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="reely", charset="UTF-8"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    // Slot is reserved eagerly so two concurrent upgrades from one IP can't
    // both pass the check and overshoot the cap.
    const current = wsConnectionsByIp.get(ip) ?? 0;
    // Only new IPs are refused when the Map is full; tracked ones still
    // increment. Evicting would lose slot accounting for live sockets.
    if (current === 0 && wsConnectionsByIp.size >= MAX_WS_IPS) {
      logger.warn(
        `WebSocket upgrade rejected: tracking Map at cap ${MAX_WS_IPS}; ` +
          `refusing new IP ${ip}.`,
      );
      socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (current >= MAX_WS_PER_IP) {
      logger.warn(
        `WebSocket upgrade rejected: ${ip} already has ${current} active connections ` +
          `(cap ${MAX_WS_PER_IP}).`,
      );
      socket.write('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wsConnectionsByIp.set(ip, current + 1);
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      const next = (wsConnectionsByIp.get(ip) ?? 1) - 1;
      if (next <= 0) wsConnectionsByIp.delete(ip);
      else wsConnectionsByIp.set(ip, next);
    };

    // Must be registered before handleUpgrade: a rejected handshake never fires
    // the upgrade callback, so the ws listeners below never run and the
    // reserved slot stays burned until restart. slotReleased makes it
    // idempotent across both registrations.
    socket.on('close', releaseSlot);

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('close', releaseSlot);
      // `close` should cover error paths, but a synchronous teardown might not.
      ws.on('error', releaseSlot);
      wss.emit('connection', ws, req);
    });
  };
