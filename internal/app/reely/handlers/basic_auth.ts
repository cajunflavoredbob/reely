import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { BasicAuth } from '../../../../types/reely';
import { getConfig } from '../config/main';
import {
  authFailureRetryAfter,
  recordAuthFailure,
} from '../middleware/authFailureThrottle';
import { logger } from '../logger';
import { clientKey } from '../util/clientKey';

// btoa is not available in older Node; Buffer is the portable equivalent.
const encodeBasic = (user: string, pass: string): string =>
  Buffer.from(`${user}:${pass}`).toString('base64');

// Normalizes both sides to a fixed length so the compare can't leak credential
// length: timingSafeEqual throws on unequal lengths and the attacker controls
// the token's. SHA-256 is a length-normalizer here, not an integrity primitive.
const hashForCompare = (s: string): Buffer =>
  createHash('sha256').update(s).digest();

// Takes the raw header so both the Express middleware and the WS upgrade
// handler can call it.
//
// Per RFC 7617 the scheme token is case-insensitive with variable whitespace,
// so parse it out instead of byte-comparing the whole header: a proxy that
// lowercases or respaces it must not break auth. The constant-time compare
// still covers the base64 credentials.
export const checkBasicAuth = (basicAuth: BasicAuth, authHeader: string | string[] | undefined): boolean => {
  const { userName, password } = basicAuth;
  // Defense in depth: the config validator rejects empty credentials, but
  // empty creds must never authenticate if one slips through.
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

  // 429 before the credential compare, so a brute force of the only access
  // gate can't guess at line rate. Once throttled even correct credentials
  // wait out the rest of the fixed window: that is the lockout, and it runs
  // for at most 60s from the first failure in the window, never longer, since
  // a throttled request returns here without recording another failure.
  //
  // Keyed on the socket peer, so behind a reverse proxy every user shares one
  // bucket and the lockout is deployment-wide: ten bad guesses from any
  // visitor lock out everyone for the rest of the window. Deliberate, and the
  // price of a key an attacker cannot forge. Must use the same key as the WS
  // upgrade path, which shares this budget.
  const ip = clientKey(req.socket.remoteAddress);
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
  // Mirrors the WS upgrade path's warning so HTTP failures are visible too.
  logger.warn(`Basic Auth failure from ${ip} on ${req.method} ${req.path}`);
  res.setHeader('WWW-Authenticate', 'Basic realm="reely", charset="UTF-8"');
  res.status(401).end();
};
