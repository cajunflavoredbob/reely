import { describe, it, expect, vi, beforeEach } from 'vitest';

// Audit 9 #145: logger.applyRedactions was rewritten in 0.4.5 from
// `redactions.reduce(split.join)` (O(N*L) per message) to a single
// combined regex pass with a cached pattern that invalidates on
// addRedaction. The new path has to escape regex metacharacters so a raw
// '+', '.', '?' in a token is matched literally, not interpreted.

// Reset modules between tests so the redaction list + compiled regex
// start fresh.
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
  // Module shape: default export + named export, matching pino's actual
  // dual-form so the static `import pino from 'pino'` resolves cleanly.
  return { __esModule: true, default: fn };
});

describe('logger applyRedactions (audit 9 #145)', () => {
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
    // Plex tokens have hyphens; URLs have dots + slashes + plus signs.
    // Each of these is a regex metacharacter that must be escaped before
    // the combined pattern is compiled.
    addRedaction('a.b+c?d');
    logger.info('value: a.b+c?d');
    expect(captured[0]).toBe('value: ****');
    // Sanity: a literal that *looks* like the regex but isn't equal must
    // NOT be redacted. (Confirms the meta-chars aren't being interpreted.)
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

// Audit 16 #441: main.ts dumps the config through JSON.stringify at DEBUG
// with redaction as the stated guard, but JSON escaping rewrites `"` and
// `\` inside string values -- a password containing either character
// matched neither the raw nor the URL-encoded registered form and printed
// unmasked. addRedaction now also registers the JSON-escaped body.
describe('addRedaction JSON-escaped form (audit 16 #441)', () => {
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
    // The JSON-escaped body (my\"pass) must be gone; only the masked
    // form remains. (Can't assert not-contains 'pass' -- the KEY name
    // "password" legitimately contains it.)
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
