import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { WebSocketServer } from 'ws';
import { logger } from '../logger';
import { getConfig } from '../config/main';
import { checkBasicAuth } from './basic_auth';
import {
  authFailureRetryAfter,
  recordAuthFailure,
} from '../middleware/authFailureThrottle';

// Cross-Site WebSocket Hijacking guard. A browser always sends an Origin
// header on a WS handshake; a non-browser client (no CSWSH risk) sends none.
// Accept a connection when: there's no Origin (non-browser), the Origin's host
// matches the request's Host (same-origin), or the exact Origin is listed in
// config.allowedOrigins (reverse-proxy escape hatch).
//
// Note: the same-origin check compares against the request Host, not a
// server-configured hostname -- reely has no served-hostname config (it binds
// 0.0.0.0). This stops standard CSWSH (an attacker cannot forge a browser's
// Origin). It does NOT stop DNS rebinding, where the attacker's own domain is
// also the request Host; that is an accepted residual for this LAN app -- no
// browser-exposed secret (the Plex token never reaches the client), and an
// operator wanting stricter control fronts reely with a proxy. ALLOWED_ORIGINS
// is the lever for known external origins.
export const isOriginAllowed = (req: IncomingMessage): boolean => {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  // Host header comparison is case-insensitive per RFC 7230. A browser
  // typically lowercases both, but normalize defensively so a proxy that
  // forwards a mixed-case Host doesn't 403 a legitimate same-origin WS
  // upgrade.
  const reqHost = req.headers.host;
  if (
    typeof reqHost === 'string' &&
    originHost.toLowerCase() === reqHost.toLowerCase()
  ) return true;
  const allowed = getConfig().allowedOrigins;
  return Array.isArray(allowed) && allowed.includes(origin);
};

// Per-IP concurrent-WS cap (audit 12 #232). The existing per-connection
// WS message rate limit (0.3.5) caps message volume per socket, but a
// single IP could otherwise open hundreds of sockets and multiply the
// per-conn limit. Keyed on socket.remoteAddress (the real TCP peer; the
// rateLimit middleware keys on req.socket.remoteAddress for the same
// reason -- can't be spoofed via X-Forwarded-For). Generous so a normal
// household behind NAT (multiple browser tabs, a phone, a laptop)
// doesn't hit the cap.
const MAX_WS_PER_IP = 20;
// Upper bound on the wsConnectionsByIp Map itself (audit 13 #291). The
// per-IP cap above bounds connections PER source IP, but the Map's
// SIZE was previously unbounded -- a flood of distinct source IPs
// (IPv6 spoofing, legitimate-but-large user base, etc.) could grow the
// Map without limit. Entries with count == 0 auto-delete (releaseSlot
// below); the cap only matters under sustained pressure of many
// concurrent active IPs. Set well above any realistic deployment: 1000
// distinct IPs at the per-IP cap of 20 = 20,000 concurrent sockets,
// which is far past anything a movie-pick app would see. When the cap
// is reached and a new IP wants in, we refuse the upgrade rather than
// evict (eviction would drop the slot accounting for active sockets).
const MAX_WS_IPS = 1000;
const wsConnectionsByIp = new Map<string, number>();

export const createWsUpgradeHandler = (wss: WebSocketServer) =>
  (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    // Cheap pathname extraction (audit 14 #367). The previous
    // `new URL(req.url ?? '', 'http://localhost').pathname` allocated a
    // full URL object purely to read pathname; this fires once per
    // WS upgrade (including failed handshakes), so the allocation
    // matters under flood. `split('?')` peels the query string + any
    // fragment fragment in one pass; the leading-slash invariant on
    // req.url is the same as URL would enforce.
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

    const ip = socket.remoteAddress ?? 'unknown';
    const config = getConfig();
    if (config.basicAuth) {
      // Failed-attempt throttle (audit 16 #425). Shares its budget with the
      // HTTP middleware so switching vectors doesn't reset the counter, and
      // runs BEFORE the credential compare so a throttled IP can't keep
      // guessing at line rate through unmetered upgrade handshakes.
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

    // Per-IP cap check: reject the upgrade if this IP already has
    // MAX_WS_PER_IP active sockets. Reserve the slot eagerly so two
    // concurrent upgrades from the same IP can't both pass the check
    // and overshoot the cap by 1.
    const current = wsConnectionsByIp.get(ip) ?? 0;
    // Map size cap (audit 13 #291): refuse upgrades from a NEW IP once
    // the tracking Map is full. Existing tracked IPs can still
    // increment their counts (up to MAX_WS_PER_IP) -- we only refuse
    // when the IP isn't yet in the Map. Eviction would lose slot
    // accounting for active sockets; refusal is the correct response.
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

    // Register cleanup on the raw socket BEFORE handleUpgrade (audit 14
    // #350). If the handshake rejects -- malformed Sec-WebSocket-Key,
    // protocol mismatch, etc. -- the upgrade callback never fires, so
    // the `ws.on('close')` registrations below never run, and the slot
    // we just reserved at line 96 stays burned permanently. Without
    // this listener, a buggy proxy or a crafted attacker can burn the
    // per-IP cap with no recovery short of process restart. The
    // `slotReleased` guard above makes the listener idempotent, so
    // it's safe to register on both the raw socket here AND the
    // upgraded ws below.
    socket.on('close', releaseSlot);

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('close', releaseSlot);
      // `close` should fire even on error paths, but listen to `error`
      // too so a synchronous teardown can't leak the slot.
      ws.on('error', releaseSlot);
      wss.emit('connection', ws, req);
    });
  };
