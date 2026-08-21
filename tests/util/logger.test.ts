import { describe, it, expect, vi, beforeEach } from 'vitest';

// applyRedactions compiles one combined regex, cached and invalidated by
// addRedaction, so it must escape metacharacters: a raw '+', '.' or '?' in a
// token has to match literally.

// Reset so the redaction list and compiled regex start fresh.
beforeEach(() => {
  vi.resetModules();
});

const captured: string[] = [];

vi.mock('pino', () => {
  const fn = () => ({
    level: 'debug',
    debug: (msg: string) => captured.push(msg),
    info: (msg: string) => captured.push(msg),
    warn: (msg: string) => captured.push(msg),
    error: (msg: string) => captured.push(msg),
    fatal: (msg: string) => captured.push(msg),
  });
  // Mirrors pino's dual form so `import pino from 'pino'` resolves.
  return { __esModule: true, default: fn };
});

describe('logger applyRedactions', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('redacts a registered value', async () => {
    const { logger, addRedaction } = await import(
      '../../internal/app/reely/logger'
    );
    addRedaction('plex-secret-token');
    logger.info('connecting with token plex-secret-token now');
    expect(captured[0]).toBe('connecting with token **** now');
  });

  it('matches a value containing regex metacharacters literally', async () => {
    const { logger, addRedaction } = await import(
      '../../internal/app/reely/logger'
    );
    // Real tokens and URLs carry hyphens, dots, slashes and plus signs.
    addRedaction('a.b+c?d');
    logger.info('value: a.b+c?d');
    expect(captured[0]).toBe('value: ****');
    // A string the unescaped pattern would match must survive.
    captured.length = 0;
    logger.info('value: axbXcYd');
    expect(captured[0]).toBe('value: axbXcYd');
  });

  it('redacts multiple values in one message', async () => {
    const { logger, addRedaction } = await import(
      '../../internal/app/reely/logger'
    );
    addRedaction('alpha');
    addRedaction('bravo');
    logger.info('alpha and bravo and alpha again');
    expect(captured[0]).toBe('**** and **** and **** again');
  });

  it('picks up a redaction registered after the first log line', async () => {
    const { logger, addRedaction } = await import(
      '../../internal/app/reely/logger'
    );
    logger.info('seen secretX nothing yet');
    expect(captured[0]).toBe('seen secretX nothing yet');
    addRedaction('secretX');
    logger.info('seen secretX now');
    expect(captured[1]).toBe('seen **** now');
  });
});

// main.ts dumps the config through JSON.stringify at DEBUG, and JSON escaping
// rewrites `"` and `\`, so a password containing either matched neither the
// raw nor the URL-encoded form and printed unmasked.
describe('addRedaction JSON-escaped form', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  it('masks a quote-containing password inside a JSON.stringify dump', async () => {
    const { logger, addRedaction } = await import(
      '../../internal/app/reely/logger'
    );
    const password = 'my"pass';
    addRedaction(password);
    logger.debug(JSON.stringify({ basicAuth: { password } }, null, 2));
    // Asserting on the escaped body, not on 'pass': the key name
    // "password" legitimately contains it.
    expect(captured[0]).not.toContain('my\\"pass');
    expect(captured[0]).toContain('****');
  });

  it('masks a backslash-containing password inside a JSON.stringify dump', async () => {
    const { logger, addRedaction } = await import(
      '../../internal/app/reely/logger'
    );
    const password = 'a\b';
    addRedaction(password);
    logger.debug(JSON.stringify({ password }));
    expect(captured[0]).not.toContain('a\\b');
    expect(captured[0]).toContain('****');
  });

  it('still masks the raw and URL-encoded forms', async () => {
    const { logger, addRedaction } = await import(
      '../../internal/app/reely/logger'
    );
    const password = 'my"pass';
    addRedaction(password);
    logger.info(`raw: ${password} encoded: ${encodeURIComponent(password)}`);
    expect(captured[0]).toBe('raw: **** encoded: ****');
  });
});
