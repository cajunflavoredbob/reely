import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

// loadFromYaml is mocked per-test via vi.mock(...) below; each test can
// override the return via the helper.
const mockLoadFromYaml = vi.fn();
vi.mock('../../internal/app/reely/config/load_yaml', () => ({
  loadFromYaml: mockLoadFromYaml,
}));

describe('loadConfig env/yaml merge', () => {
  // Tests share env-var pollution; reset on each run.
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockLoadFromYaml.mockReset();
    // Strip every env key the loader looks at so individual tests start clean.
    // `LIBRARY_TYPE_FILTER` + `MOVIE_LINK_TYPE` (which the loader hasn't read
    // since 0.4.1's movies-only scope collapse and earlier) were retired here
    // in 0.4.8 #179 to stop inviting confusion about which env vars are live.
    for (const k of [
      'PLEX_URL', 'PLEX_TOKEN', 'LIBRARY_TITLE_FILTER',
      'AUTH_USER', 'AUTH_PASS', 'TLS_CERT', 'TLS_KEY',
      'HOST', 'PORT', 'LOG_LEVEL', 'ROOT_PATH', 'ALLOWED_ORIGINS',
      'EXPOSE_PLEX_BASE_URL',
      'SECRETS_DIR',
    ]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('env-only config produces a usable Config with defaults filled in', async () => {
    process.env.PLEX_URL = 'http://192.168.1.10:32400';
    process.env.PLEX_TOKEN = 'tok';
    mockLoadFromYaml.mockResolvedValue({});

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/dev/null');

    expect(config.servers[0].url).toBe('http://192.168.1.10:32400');
    expect(config.servers[0].token).toBe('tok');
    // applyDefaults fills these in.
    expect(config.hostname).toBe('0.0.0.0');
    expect(config.port).toBe(8000);
    expect(config.logLevel).toBe('INFO');
  });

  // #54: ALLOWED_ORIGINS is comma-split into config.allowedOrigins.
  it('parses ALLOWED_ORIGINS into config.allowedOrigins', async () => {
    process.env.PLEX_URL = 'http://env.host:32400';
    process.env.PLEX_TOKEN = 'tok';
    process.env.ALLOWED_ORIGINS = 'https://a.example.com, https://b.example.com';
    mockLoadFromYaml.mockResolvedValue({});

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/dev/null');

    expect(config.allowedOrigins).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('env vars override top-level yaml values', async () => {
    mockLoadFromYaml.mockResolvedValue({
      port: 9000,
      logLevel: 'DEBUG',
      servers: [{ url: 'http://yaml.host:32400', token: 'yaml-tok' }],
    });
    process.env.PORT = '8500';
    process.env.LOG_LEVEL = 'WARNING';
    process.env.PLEX_URL = 'http://env.host:32400';
    process.env.PLEX_TOKEN = 'env-tok';

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/tmp/fake-config.yaml');

    expect(config.port).toBe(8500);            // env wins
    expect(config.logLevel).toBe('WARNING');   // env wins
    expect(config.servers[0].url).toBe('http://env.host:32400');
    expect(config.servers[0].token).toBe('env-tok');
  });

  // #65: env config no longer index-merges into the yaml server. If env
  // defines a server at all, it replaces the yaml server wholesale -- a
  // per-field merge could pair an env token with a yaml URL.
  it('replaces the yaml server outright when env defines a server (#65)', async () => {
    mockLoadFromYaml.mockResolvedValue({
      servers: [
        { url: 'http://yaml.host:32400', token: 'yaml-tok', libraryTitleFilter: ['Movies'] },
      ],
    });
    process.env.PLEX_URL = 'http://env.host:32400';
    process.env.PLEX_TOKEN = 'env-tok';

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/tmp/fake-config.yaml');

    expect(config.servers).toHaveLength(1);
    expect(config.servers[0].url).toBe('http://env.host:32400');
    expect(config.servers[0].token).toBe('env-tok');
    // The yaml-only libraryTitleFilter is NOT carried over.
    expect(config.servers[0].libraryTitleFilter).toBeUndefined();
  });

  it('uses the yaml server when env defines none', async () => {
    mockLoadFromYaml.mockResolvedValue({
      servers: [{ url: 'http://yaml.host:32400', token: 'yaml-tok' }],
    });

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/tmp/fake-config.yaml');

    expect(config.servers[0].url).toBe('http://yaml.host:32400');
    expect(config.servers[0].token).toBe('yaml-tok');
  });

  it('skips the yaml file load entirely when path is /dev/null', async () => {
    process.env.PLEX_URL = 'http://env.host:32400';
    process.env.PLEX_TOKEN = 'tok';

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig('/dev/null');

    expect(mockLoadFromYaml).not.toHaveBeenCalled();
    expect(config.servers[0].url).toBe('http://env.host:32400');
  });

  it('rethrows when an explicit path is missing on disk', async () => {
    // With an explicit path, any load error is fatal regardless of type.
    mockLoadFromYaml.mockRejectedValue(new Error('/explicit/path.yaml does not exist'));

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    await expect(loadConfig('/explicit/path.yaml')).rejects.toThrow(/does not exist/);
  });

  it('tolerates a missing default config file', async () => {
    // No path argument -> falls back to cwd/config.yaml. A genuine
    // file-not-found there is acceptable: loadConfig returns env+defaults.
    // ConfigFileNotFoundError is imported here (not at module scope) so it's
    // the same class instance the freshly-imported loadConfig sees -- the
    // beforeEach vi.resetModules() would otherwise break the instanceof check.
    const { ConfigFileNotFoundError } = await import('../../internal/app/reely/config/errors');
    mockLoadFromYaml.mockRejectedValue(new ConfigFileNotFoundError('default path absent'));
    process.env.PLEX_URL = 'http://env.host:32400';
    process.env.PLEX_TOKEN = 'tok';

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig();

    expect(config.servers[0].url).toBe('http://env.host:32400');
    expect(config.port).toBe(8000); // default
  });

  // #42: a malformed or unreadable default config file is NOT a missing file;
  // swallowing it would silently start the server with the wrong config.
  it('rethrows a malformed default config file rather than swallowing it (#42)', async () => {
    mockLoadFromYaml.mockRejectedValue(new Error('bad YAML indentation'));

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    await expect(loadConfig()).rejects.toThrow(/bad YAML/);
  });

  // Audit 12 #207: scheme-less PLEX_URL used to silently downgrade to
  // http:// with a log warning. 0.4.8 forces an explicit scheme so the
  // operator can't accidentally ship the Plex token in cleartext.
  it('throws when PLEX_URL has no scheme (audit 12 #207)', async () => {
    process.env.PLEX_URL = '192.168.1.10:32400';
    process.env.PLEX_TOKEN = 'tok';
    mockLoadFromYaml.mockResolvedValue({});

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    await expect(loadConfig('/dev/null')).rejects.toThrow(/no scheme/);
  });

  // Audit 12 #198: a partial env config (only LIBRARY_TITLE_FILTER, only
  // AUTH_USER, only TLS_CERT) used to emit a half-bundle that spread over
  // the YAML and erased the partner field. The fix gates each bundle on
  // having both required halves; without them, the env contribution to
  // that bundle is dropped and the YAML value survives.
  describe('partial env bundles preserve YAML (audit 12 #198)', () => {
    it('LIBRARY_TITLE_FILTER alone preserves YAML server credentials', async () => {
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ url: 'http://yaml:32400', token: 'yaml-tok' }],
      });
      process.env.LIBRARY_TITLE_FILTER = 'Movies,Kids Movies';

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake.yaml');

      // YAML's url + token survive; the env LIBRARY_TITLE_FILTER does
      // NOT bleed into the server entry on its own (no url + token).
      expect(config.servers[0].url).toBe('http://yaml:32400');
      expect(config.servers[0].token).toBe('yaml-tok');
      expect(config.servers[0].libraryTitleFilter).toBeUndefined();
    });

    it('AUTH_USER alone preserves YAML basicAuth password', async () => {
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ url: 'http://yaml:32400', token: 'yaml-tok' }],
        basicAuth: { userName: 'yaml-user', password: 'yaml-pass' },
      });
      process.env.AUTH_USER = 'env-user';

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake.yaml');

      expect(config.basicAuth?.userName).toBe('yaml-user');
      expect(config.basicAuth?.password).toBe('yaml-pass');
    });

    it('TLS_CERT alone preserves YAML tlsConfig keyFile', async () => {
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ url: 'http://yaml:32400', token: 'yaml-tok' }],
        tlsConfig: { certFile: '/yaml/cert.pem', keyFile: '/yaml/key.pem' },
      });
      process.env.TLS_CERT = '/env/cert.pem';

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake.yaml');

      expect(config.tlsConfig?.certFile).toBe('/yaml/cert.pem');
      expect(config.tlsConfig?.keyFile).toBe('/yaml/key.pem');
    });

    it('full env basicAuth bundle still overrides YAML', async () => {
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ url: 'http://yaml:32400', token: 'yaml-tok' }],
        basicAuth: { userName: 'yaml-user', password: 'yaml-pass' },
      });
      process.env.AUTH_USER = 'env-user';
      process.env.AUTH_PASS = 'env-pass';

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake.yaml');

      expect(config.basicAuth?.userName).toBe('env-user');
      expect(config.basicAuth?.password).toBe('env-pass');
    });
  });

  // 0.4.15: EXPOSE_PLEX_BASE_URL opt-out for the WS-frame Plex URL exposure
  // (closes audit 10 #165 / audit 12 #226). Default true preserves the
  // 0.3.20 behavior; false makes sendConfig() withhold the field.
  describe('EXPOSE_PLEX_BASE_URL (audits 10 #165 + 12 #226)', () => {
    const baseEnv = () => {
      process.env.PLEX_URL = 'http://env.host:32400';
      process.env.PLEX_TOKEN = 'tok';
    };

    it('defaults to true when unset', async () => {
      baseEnv();
      mockLoadFromYaml.mockResolvedValue({});

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/dev/null');

      expect(config.exposePlexBaseUrl).toBe(true);
    });

    it('parses EXPOSE_PLEX_BASE_URL=false', async () => {
      baseEnv();
      process.env.EXPOSE_PLEX_BASE_URL = 'false';
      mockLoadFromYaml.mockResolvedValue({});

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/dev/null');

      expect(config.exposePlexBaseUrl).toBe(false);
    });

    it.each(['0', 'no', 'off', 'FALSE', 'No', 'Off'])(
      'accepts %j as false',
      async (value) => {
        baseEnv();
        process.env.EXPOSE_PLEX_BASE_URL = value;
        mockLoadFromYaml.mockResolvedValue({});

        const { loadConfig } = await import('../../internal/app/reely/config/main');
        const [config] = await loadConfig('/dev/null');

        expect(config.exposePlexBaseUrl).toBe(false);
      },
    );

    it.each(['1', 'yes', 'on', 'TRUE', 'Yes', 'On'])(
      'accepts %j as true',
      async (value) => {
        baseEnv();
        process.env.EXPOSE_PLEX_BASE_URL = value;
        mockLoadFromYaml.mockResolvedValue({});

        const { loadConfig } = await import('../../internal/app/reely/config/main');
        const [config] = await loadConfig('/dev/null');

        expect(config.exposePlexBaseUrl).toBe(true);
      },
    );

    it('throws on a garbage value (no silent fallback to default)', async () => {
      baseEnv();
      process.env.EXPOSE_PLEX_BASE_URL = 'maybe';
      mockLoadFromYaml.mockResolvedValue({});

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      await expect(loadConfig('/dev/null')).rejects.toThrow(/not a valid boolean/);
    });

    it('env overrides yaml exposePlexBaseUrl', async () => {
      baseEnv();
      process.env.EXPOSE_PLEX_BASE_URL = 'false';
      mockLoadFromYaml.mockResolvedValue({ exposePlexBaseUrl: true });

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake.yaml');

      expect(config.exposePlexBaseUrl).toBe(false);
    });
  });
});
