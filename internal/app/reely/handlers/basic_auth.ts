import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { BasicAuth } from '../../../../types/reely';
import { getConfig } from '../config/main';
import {
  authFailureRetryAfter,
  recordAuthFailure,
} from '../middleware/authFailureThrottle';
import { logger } from '../logger';

// btoa is not available in older Node; Buffer is the portable equivalent.
const encodeBasic = (user: string, pass: string): string =>
  Buffer.from(`${user}:${pass}`).toString('base64');

// Hash both sides to fixed-length buffers before comparing so the comparison
// itself can't leak credential length via timing (timingSafeEqual throws on
// unequal-length inputs, and an attacker controls the actual-token length).
// SHA-256 is a length-normalizer here, not an integrity primitive -- there's
// no secret involved. Audit 15 #397 swapped the prior createHmac form for
// createHash since the HMAC key was hardcoded and never used as a secret;
// one fewer crypto op per auth request, same constant-time compare.
const hashForCompare = (s: string): Buffer =>
  createHash('sha256').update(s).digest();

// Accepts the raw Authorization header value so this can be called from both
// the Express middleware and the WebSocket upgrade handler.
//
// RFC 7617: the auth-scheme token ("Basic") is case-insensitive and may be
// followed by varying whitespace. Parse the scheme and credentials out of the
// header rather than byte-comparing the whole string, so a proxy that
// lowercases the scheme or adjusts whitespace doesn't break auth. The
// constant-time compare still covers the base64 credentials token.
export const checkBasicAuth = (basicAuth: BasicAuth, authHeader: string | string[] | undefined): boolean => {
  const { userName, password } = basicAuth;
  // Fail closed if either configured credential is empty. The validator
  // already rejects empty credentials at config load; this is defense in
  // depth so empty creds can never authenticate even if one slips through.
  if (!userName || !password) return false;
  const raw = typeof authHeader === 'string' ? authHeader : '';
  const parsed = raw.match(/^\s*([A-Za-z]+)\s+(\S+)\s*$/);
  const scheme = parsed?.[1].toLowerCase() ?? '';
  const token = scheme === 'basic' ? (parsed?.[2] ?? '') : '';

  const expected = hashForCompare(encodeBasic(userName, password));
  const actual = hashForCompare(token);
  return timingSafeEqual(expected, actual);
};

export const isAuthorized = (basicAuth: BasicAuth, req: Request): boolean =>
  checkBasicAuth(basicAuth, req.headers.authorization);

export const handler = (req: Request, res: Response, next: NextFunction): void => {
  const config = getConfig();

  if (!config.basicAuth) {
    next();
    return;
  }

  // Failed-attempt throttle (audit 16 #425): an IP that has exhausted its
  // failure budget gets 429 BEFORE the credential compare, so an online
  // brute force of the only access gate can't guess at line rate. Checked
  // ahead of isAuthorized -- once throttled, even correct credentials wait
  // out the window (that's the lockout, and it's at most 60s).
  const ip = req.socket.remoteAddress ?? 'unknown';
  const retryAfter = authFailureRetryAfter(ip);
  if (retryAfter > 0) {
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).send('Too many requests');
    return;
  }

  if (isAuthorized(config.basicAuth, req)) {
    next();
    return;
  }

  recordAuthFailure(ip);
  // The WS upgrade path already warns on rejection; mirror it here so
  // failed HTTP attempts are visible in the log too.
  logger.warn(`Basic Auth failure from ${ip} on ${req.method} ${req.path}`);
  res.setHeader('WWW-Authenticate', 'Basic realm="reely", charset="UTF-8"');
  res.status(401).end();
};
