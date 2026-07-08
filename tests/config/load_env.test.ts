import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock readDockerSecret BEFORE importing load_env. The default returns
// undefined so the env vars are the only signal; individual tests can
// override it to exercise the secret-takes-precedence path.
//
// vi.hoisted is required here because vi.mock is itself hoisted above
// imports; a plain `const dockerSecretMock = vi.fn()` at module top
// would be in TDZ when the mock factory ran. Same root cause as the
// loggerMockFactory closure-form pattern from audit 13 / 0.4.24.
const { dockerSecretMock } = vi.hoisted(() => ({
  dockerSecretMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../internal/app/reely/config/load_secrets', () => ({
  readDockerSecret: dockerSecretMock,
}));

import { loadFromEnv } from '../../internal/app/reely/config/load_env';

beforeEach(() => {
  dockerSecretMock.mockClear();
  dockerSecretMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadFromEnv: trivial / empty', () => {
  it('returns undefined when no recognized env vars are set', async () => {
    expect(await loadFromEnv()).toBeUndefined();
  });
});

describe('loadFromEnv: scalar values', () => {
  it('reads HOST as a string', async () => {
    vi.stubEnv('HOST', '127.0.0.1');
    expect((await loadFromEnv())?.hostname).toBe('127.0.0.1');
  });

  it('reads PORT as a number', async () => {
    vi.stubEnv('PORT', '9000');
    expect((await loadFromEnv())?.port).toBe(9000);
  });

  // Number('abc') -> NaN; the loader rejects rather than letting NaN
  // override the default downstream.
  it('throws on a non-numeric PORT', async () => {
    vi.stubEnv('PORT', 'abc');
    await expect(loadFromEnv()).rejects.toThrow(/PORT="abc" is not a valid number/);
  });

  // Audit 12 #236: hostile env values get JSON.stringify-quoted in the
  // error so a `PORT="<script>..."` doesn't land in container logs as
  // raw HTML/script characters.
  it('JSON-quotes the offending PORT value in the error message (audit 12 #236)', async () => {
    vi.stubEnv('PORT', '<script>');
    await expect(loadFromEnv()).rejects.toThrow(/PORT="<script>"/);
  });

  it('reads LOG_LEVEL as a string', async () => {
    vi.stubEnv('LOG_LEVEL', 'DEBUG');
    expect((await loadFromEnv())?.logLevel).toBe('DEBUG');
  });

  it('reads ROOT_PATH as a string', async () => {
    vi.stubEnv('ROOT_PATH', '/reely');
    expect((await loadFromEnv())?.rootPath).toBe('/reely');
  });
});

describe('loadFromEnv: EnvBool parsing', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['no', false],
    ['off', false],
  ])('parses EXPOSE_PLEX_BASE_URL=%s as %s', async (raw, expected) => {
    vi.stubEnv('EXPOSE_PLEX_BASE_URL', raw);
    expect((await loadFromEnv())?.exposePlexBaseUrl).toBe(expected);
  });

  // Silent coercion of an invalid value to the default would HIDE the
  // typo (EXPOSE_PLEX_BASE_URL=ture would just be "false"). Throw instead.
  it('throws on an invalid boolean value (no silent coercion to default)', async () => {
    vi.stubEnv('EXPOSE_PLEX_BASE_URL', 'ture');
    await expect(loadFromEnv()).rejects.toThrow(/not a valid boolean/);
  });
});

describe('loadFromEnv: EnvList parsing', () => {
  it('splits ALLOWED_ORIGINS on commas and trims segments', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'http://a, http://b , http://c');
    expect((await loadFromEnv())?.allowedOrigins).toEqual(['http://a', 'http://b', 'http://c']);
  });

  it('drops empty segments so "a,,b" yields ["a","b"]', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'http://a,,http://b');
    expect((await loadFromEnv())?.allowedOrigins).toEqual(['http://a', 'http://b']);
  });
});

describe('loadFromEnv: PLEX_URL scheme enforcement (audit 12 #207)', () => {
  // Prior loader silently downgraded a scheme-less PLEX_URL to http:// and
  // logged a warning that's easy to miss in container logs. Since the Plex
  // token rides in that URL, the scheme determines whether it travels
  // encrypted. Forcing an explicit scheme is a deliberate UX trade.
  it('throws when PLEX_URL has no scheme', async () => {
    vi.stubEnv('PLEX_URL', 'plex.local:32400');
    vi.stubEnv('PLEX_TOKEN', 'tok');
    await expect(loadFromEnv()).rejects.toThrow(/has no scheme/);
  });

  it('accepts http:// PLEX_URL', async () => {
    vi.stubEnv('PLEX_URL', 'http://plex.local:32400');
    vi.stubEnv('PLEX_TOKEN', 'tok');
    const out = await loadFromEnv();
    expect(out?.servers?.[0]?.url).toBe('http://plex.local:32400');
  });

  it('accepts https:// PLEX_URL', async () => {
    vi.stubEnv('PLEX_URL', 'https://plex.example.com');
    vi.stubEnv('PLEX_TOKEN', 'tok');
    const out = await loadFromEnv();
    expect(out?.servers?.[0]?.url).toBe('https://plex.example.com');
  });
});

describe('loadFromEnv: partial-bundle gates (audit 12 #198)', () => {
  // Each multi-field bundle (server, basicAuth, tlsConfig) is emitted ONLY
  // when both halves of its required pair are present. Without the gate,
  // setting only one half emits a bundle that spreads over YAML and
  // ERASES the partner field that was already configured there.

  it('emits a server bundle only when BOTH PLEX_URL and PLEX_TOKEN are set', async () => {
    vi.stubEnv('PLEX_URL', 'http://plex.local');
    vi.stubEnv('PLEX_TOKEN', 'tok');
    const out = await loadFromEnv();
    expect(out?.servers).toEqual([{ url: 'http://plex.local', token: 'tok' }]);
  });

  it('emits NO server bundle when PLEX_URL is set but PLEX_TOKEN is missing', async () => {
    vi.stubEnv('PLEX_URL', 'http://plex.local');
    expect((await loadFromEnv())?.servers).toBeUndefined();
  });

  it('emits NO server bundle when PLEX_TOKEN is set but PLEX_URL is missing', async () => {
    vi.stubEnv('PLEX_TOKEN', 'tok');
    expect((await loadFromEnv())?.servers).toBeUndefined();
  });

  it('includes LIBRARY_TITLE_FILTER in the server bundle when the pair already qualifies', async () => {
    vi.stubEnv('PLEX_URL', 'http://plex.local');
    vi.stubEnv('PLEX_TOKEN', 'tok');
    vi.stubEnv('LIBRARY_TITLE_FILTER', 'Movies,Films');
    const server = (await loadFromEnv())?.servers?.[0];
    expect(server?.libraryTitleFilter).toEqual(['Movies', 'Films']);
  });

  it('emits a basicAuth bundle only when BOTH AUTH_USER and AUTH_PASS are set', async () => {
    vi.stubEnv('AUTH_USER', 'admin');
    vi.stubEnv('AUTH_PASS', 'hunter2');
    expect((await loadFromEnv())?.basicAuth).toEqual({ userName: 'admin', password: 'hunter2' });
  });

  it('emits NO basicAuth bundle when only AUTH_USER is set', async () => {
    vi.stubEnv('AUTH_USER', 'admin');
    expect((await loadFromEnv())?.basicAuth).toBeUndefined();
  });

  it('emits a tlsConfig bundle only when BOTH TLS_CERT and TLS_KEY are set', async () => {
    vi.stubEnv('TLS_CERT', '/etc/ssl/cert.pem');
    vi.stubEnv('TLS_KEY', '/etc/ssl/key.pem');
    expect((await loadFromEnv())?.tlsConfig).toEqual({
      certFile: '/etc/ssl/cert.pem',
      keyFile: '/etc/ssl/key.pem',
    });
  });

  it('emits NO tlsConfig bundle when only TLS_CERT is set', async () => {
    vi.stubEnv('TLS_CERT', '/etc/ssl/cert.pem');
    expect((await loadFromEnv())?.tlsConfig).toBeUndefined();
  });
});

describe('loadFromEnv: docker secrets take precedence over env vars', () => {
  // Audit 12 #209 made readDockerSecret async; loadFromEnv awaits it.
  // The secret takes precedence when present, so an operator who's set
  // up a secret can leave the env var unset (or even set, for migration)
  // and the secret wins.
  it('uses the plex_token docker secret over PLEX_TOKEN env when both are set', async () => {
    dockerSecretMock.mockImplementation((name: string) =>
      Promise.resolve(name === 'plex_token' ? 'secret-tok' : undefined),
    );
    vi.stubEnv('PLEX_URL', 'http://plex.local');
    vi.stubEnv('PLEX_TOKEN', 'env-tok');
    expect((await loadFromEnv())?.servers?.[0]?.token).toBe('secret-tok');
  });

  it('uses the auth_pass docker secret over AUTH_PASS env when both are set', async () => {
    dockerSecretMock.mockImplementation((name: string) =>
      Promise.resolve(name === 'auth_pass' ? 'secret-pass' : undefined),
    );
    vi.stubEnv('AUTH_USER', 'admin');
    vi.stubEnv('AUTH_PASS', 'env-pass');
    expect((await loadFromEnv())?.basicAuth?.password).toBe('secret-pass');
  });
});
