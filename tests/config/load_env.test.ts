import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Defaults to undefined so env vars are the only signal. vi.hoisted is
// required: a plain const would be in TDZ when the hoisted mock factory runs.
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

  // Guards against NaN overriding the default downstream.
  it('throws on a non-numeric PORT', async () => {
    vi.stubEnv('PORT', 'abc');
    await expect(loadFromEnv()).rejects.toThrow(/PORT="abc" is not a valid number/);
  });

  // Hostile env values are JSON-quoted so they cannot land in container logs
  // as raw script characters.
  it('JSON-quotes the offending PORT value in the error message', async () => {
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

  // Coercing an invalid value to the default hides the typo: `ture` would
  // read as false.
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

describe('loadFromEnv: PLEX_URL scheme enforcement', () => {
  // The Plex token rides in this URL, so the scheme decides whether it
  // travels encrypted. A silent downgrade to http:// is not acceptable.
  it('throws when PLEX_URL has no scheme', async () => {
    vi.stubEnv('PLEX_URL', 'plex.local:32400');
    vi.stubEnv('PLEX_TOKEN', 'tok');
    await expect(loadFromEnv()).rejects.toThrow(/has no scheme/);
  });

  // This throw is logged at fatal before registerRedactions has run, so the
  // message must name the variable without echoing the address.
  it('names PLEX_URL without echoing the configured address', async () => {
    vi.stubEnv('PLEX_URL', 'plex.local:32400');
    vi.stubEnv('PLEX_TOKEN', 'tok');
    const err = await loadFromEnv().then(
      () => { throw new Error('loadFromEnv resolved instead of rejecting'); },
      (e: Error) => e,
    );
    expect(err.message).toMatch(/PLEX_URL has no scheme/);
    expect(err.message).not.toContain('plex.local');
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

describe('loadFromEnv: partial-bundle gates', () => {
  // Each bundle (server, basicAuth, tlsConfig) is emitted only when both
  // halves of its pair are set. A half-bundle spreads over the YAML and
  // erases the partner field configured there.

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

describe('loadFromEnv: a blank half of a pair is a misconfiguration, not an opt-out', () => {
  // `AUTH_PASS=${REELY_PASS}` in a compose file with REELY_PASS unset reaches
  // the container as AUTH_PASS=. Dropping the bundle there boots the server
  // with authentication off while the operator believes it is on.
  it('throws when AUTH_PASS is empty and AUTH_USER has a value', async () => {
    vi.stubEnv('AUTH_USER', 'admin');
    vi.stubEnv('AUTH_PASS', '');
    await expect(loadFromEnv()).rejects.toThrow(/AUTH_PASS is set to an empty value/);
  });

  it('throws when AUTH_PASS is whitespace only', async () => {
    vi.stubEnv('AUTH_USER', 'admin');
    vi.stubEnv('AUTH_PASS', '   ');
    await expect(loadFromEnv()).rejects.toThrow(/AUTH_PASS is set to an empty value/);
  });

  it('throws when AUTH_USER is empty and AUTH_PASS has a value', async () => {
    vi.stubEnv('AUTH_USER', '');
    vi.stubEnv('AUTH_PASS', 'hunter2');
    await expect(loadFromEnv()).rejects.toThrow(/AUTH_USER is set to an empty value/);
  });

  it('throws when TLS_KEY is empty and TLS_CERT has a value', async () => {
    vi.stubEnv('TLS_CERT', '/etc/ssl/cert.pem');
    vi.stubEnv('TLS_KEY', '');
    await expect(loadFromEnv()).rejects.toThrow(/TLS_KEY is set to an empty value/);
  });

  // A template .env with every var listed and left blank is an opt-out, not a
  // half-configured pair.
  it('accepts both halves blank as "not configured"', async () => {
    vi.stubEnv('AUTH_USER', '');
    vi.stubEnv('AUTH_PASS', '');
    vi.stubEnv('TLS_CERT', '');
    vi.stubEnv('TLS_KEY', '');
    const out = await loadFromEnv();
    expect(out?.basicAuth).toBeUndefined();
    expect(out?.tlsConfig).toBeUndefined();
  });

  // An unset partner still means "this bundle was never configured"; only a
  // supplied-but-empty one is an error.
  it('still drops the bundle silently when the partner var is absent', async () => {
    vi.stubEnv('AUTH_USER', 'admin');
    expect((await loadFromEnv())?.basicAuth).toBeUndefined();
  });

  // The secret supplies the password, so a leftover blank AUTH_PASS is not a
  // gap at all.
  it('does not throw when a docker secret fills the blank half', async () => {
    dockerSecretMock.mockImplementation((name: string) =>
      Promise.resolve(name === 'auth_pass' ? 'secret-pass' : undefined),
    );
    vi.stubEnv('AUTH_USER', 'admin');
    vi.stubEnv('AUTH_PASS', '');
    expect((await loadFromEnv())?.basicAuth?.password).toBe('secret-pass');
  });
});

describe('loadFromEnv: docker secrets take precedence over env vars', () => {
  // A present secret wins, so migrating operators can leave the env var set.
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
