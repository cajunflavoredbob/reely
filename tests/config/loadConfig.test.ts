import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

const mockLoadFromYaml = vi.fn();
vi.mock('../../internal/app/reely/config/load_yaml', () => ({
  loadFromYaml: mockLoadFromYaml,
}));

describe('loadConfig env/yaml merge', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockLoadFromYaml.mockReset();
    // Every env key the loader reads, so each test starts clean.
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

  // An env server replaces the yaml server wholesale: a per-field merge could
  // pair an env token with a yaml URL.
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
    // The yaml-only libraryTitleFilter is not carried over.
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
    // With an explicit path, any load error is fatal.
    mockLoadFromYaml.mockRejectedValue(new Error('/explicit/path.yaml does not exist'));

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    await expect(loadConfig('/explicit/path.yaml')).rejects.toThrow(/does not exist/);
  });

  it('tolerates a missing default config file', async () => {
    // Imported here, not at module scope: vi.resetModules() would otherwise
    // give loadConfig a different class and break the instanceof check.
    const { ConfigFileNotFoundError } = await import('../../internal/app/reely/config/errors');
    mockLoadFromYaml.mockRejectedValue(new ConfigFileNotFoundError('default path absent'));
    process.env.PLEX_URL = 'http://env.host:32400';
    process.env.PLEX_TOKEN = 'tok';

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    const [config] = await loadConfig();

    expect(config.servers[0].url).toBe('http://env.host:32400');
    expect(config.port).toBe(8000); // default
  });

  // A malformed default config file is not a missing one; swallowing it
  // starts the server with the wrong config.
  it('rethrows a malformed default config file rather than swallowing it (#42)', async () => {
    mockLoadFromYaml.mockRejectedValue(new Error('bad YAML indentation'));

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    await expect(loadConfig()).rejects.toThrow(/bad YAML/);
  });

  // A scheme-less PLEX_URL must not silently downgrade to http://: the Plex
  // token would ship in cleartext.
  it('throws when PLEX_URL has no scheme', async () => {
    process.env.PLEX_URL = '192.168.1.10:32400';
    process.env.PLEX_TOKEN = 'tok';
    mockLoadFromYaml.mockResolvedValue({});

    const { loadConfig } = await import('../../internal/app/reely/config/main');
    await expect(loadConfig('/dev/null')).rejects.toThrow(/no scheme/);
  });

  // Guards against a half-set env bundle spreading over the YAML and erasing
  // the partner field. Each bundle needs both halves or it is dropped.
  describe('partial env bundles preserve YAML', () => {
    it('LIBRARY_TITLE_FILTER alone preserves YAML server credentials', async () => {
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ url: 'http://yaml:32400', token: 'yaml-tok' }],
      });
      process.env.LIBRARY_TITLE_FILTER = 'Movies,Kids Movies';

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake.yaml');

      // Without a url and token, the env filter cannot enter the server entry.
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

  // The replacement is deliberate, but a YAML-only libraryTitleFilter going
  // with it puts every movie library in the deck, so it has to be logged.
  describe('the env server replacing the YAML one is announced', () => {
    const warnings = async (yamlServers: unknown) => {
      mockLoadFromYaml.mockResolvedValue({ servers: yamlServers });
      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const { logger } = await import('../../internal/app/reely/logger');
      await loadConfig('/tmp/fake.yaml');
      return (logger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => String(call[0]));
    };

    it('names the fields the env server dropped', async () => {
      process.env.PLEX_URL = 'http://env.host:32400';
      process.env.PLEX_TOKEN = 'env-tok';

      const warned = await warnings([
        { url: 'http://yaml:32400', token: 'yaml-tok', libraryTitleFilter: ['Kids Movies'] },
      ]);

      expect(warned.some((msg) => msg.includes('libraryTitleFilter'))).toBe(true);
    });

    it('says nothing when no YAML server was replaced', async () => {
      process.env.PLEX_URL = 'http://env.host:32400';
      process.env.PLEX_TOKEN = 'env-tok';

      expect(await warnings([])).toEqual([]);
    });
  });

  // Secrets are read inside the env layer, gated on an env-var partner. A
  // partner that lives in config.yaml does not open that gate, so the secret
  // used to be read, validated and then thrown away.
  describe('docker secrets fill gaps left by the merge', () => {
    let secretsDir: string;

    beforeEach(async () => {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      secretsDir = mkdtempSync(join(tmpdir(), 'reely-loadconfig-secrets-'));
      process.env.SECRETS_DIR = secretsDir;
    });

    afterEach(async () => {
      const { rmSync } = await import('node:fs');
      rmSync(secretsDir, { recursive: true, force: true });
    });

    const writeSecret = async (name: string, contents: string) => {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      writeFileSync(join(secretsDir, name), contents);
    };

    it('gives a tokenless YAML server the plex_token secret', async () => {
      await writeSecret('plex_token', 'secret-tok\n');
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ url: 'http://yaml:32400' }],
      });

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config, errors] = await loadConfig('/tmp/fake.yaml');

      expect(errors).toEqual([]);
      expect(config.servers[0].token).toBe('secret-tok');
    });

    it('leaves a token that came from config.yaml alone and says the secret went unused', async () => {
      await writeSecret('plex_token', 'secret-tok\n');
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ url: 'http://yaml:32400', token: 'yaml-tok' }],
      });

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const { logger } = await import('../../internal/app/reely/logger');
      const [config] = await loadConfig('/tmp/fake.yaml');

      expect(config.servers[0].token).toBe('yaml-tok');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('plex_token secret file was read but nothing used it'),
      );
    });

    it('does not guess which of several tokenless servers the secret belongs to', async () => {
      await writeSecret('plex_token', 'secret-tok\n');
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ url: 'http://a:32400' }, { url: 'http://b:32400' }],
      });

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config] = await loadConfig('/tmp/fake.yaml');

      expect(config.servers.every((server) => !server.token)).toBe(true);
    });

    it('gives a YAML basicAuth user the auth_pass secret', async () => {
      await writeSecret('auth_pass', 'secret-pass\n');
      mockLoadFromYaml.mockResolvedValue({
        servers: [{ url: 'http://yaml:32400', token: 'yaml-tok' }],
        basicAuth: { userName: 'yaml-user' },
      });

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const [config, errors] = await loadConfig('/tmp/fake.yaml');

      expect(errors).toEqual([]);
      expect(config.basicAuth?.password).toBe('secret-pass');
    });

    it('says nothing when the env layer already placed the secret', async () => {
      await writeSecret('plex_token', 'secret-tok\n');
      process.env.PLEX_URL = 'http://env.host:32400';
      mockLoadFromYaml.mockResolvedValue({});

      const { loadConfig } = await import('../../internal/app/reely/config/main');
      const { logger } = await import('../../internal/app/reely/logger');
      const [config] = await loadConfig('/tmp/fake.yaml');

      expect(config.servers[0].token).toBe('secret-tok');
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('EXPOSE_PLEX_BASE_URL', () => {
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
