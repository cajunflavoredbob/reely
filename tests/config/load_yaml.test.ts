import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFromYaml } from '../../internal/app/reely/config/load_yaml';
import { ConfigFileNotFoundError } from '../../internal/app/reely/config/errors';

// Real-tempdir tests: cleaner than mocking fs since js-yaml is the actual
// parser doing the work and the JSON_SCHEMA gating is a property of the
// parser call. Each test gets its own tempdir + cleanup in afterEach.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reely-load-yaml-'));
});

afterEach(async () => {
  // Restore perms on anything chmod-ed during the test so the cleanup
  // can read + remove it (otherwise rm fails on the EACCES test case).
  await chmod(dir, 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const writeYaml = async (name: string, contents: string): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, contents, 'utf-8');
  return path;
};

describe('loadFromYaml: happy path', () => {
  it('parses a valid YAML file into the expected partial Config', async () => {
    const path = await writeYaml(
      'config.yaml',
      `port: 9000
hostname: 127.0.0.1
servers:
  - url: http://plex
    token: tok
`,
    );
    const out = await loadFromYaml(path);
    expect(out).toEqual({
      port: 9000,
      hostname: '127.0.0.1',
      servers: [{ url: 'http://plex', token: 'tok' }],
    });
  });

  it('parses an empty-object YAML file into an empty object', async () => {
    const path = await writeYaml('config.yaml', '{}\n');
    expect(await loadFromYaml(path)).toEqual({});
  });
});

describe('loadFromYaml: error mapping', () => {
  // Only the "file genuinely missing" case gets the typed
  // ConfigFileNotFoundError so loadConfig can fall through to env-only.
  // Anything else (EACCES, EISDIR, malformed YAML, etc.) propagates with
  // its real cause so operators see a diagnostic that points at the
  // actual problem.
  it('throws ConfigFileNotFoundError on ENOENT', async () => {
    const missing = join(dir, 'nope.yaml');
    await expect(loadFromYaml(missing)).rejects.toBeInstanceOf(ConfigFileNotFoundError);
    await expect(loadFromYaml(missing)).rejects.toThrow(/does not exist/);
  });

  it('propagates EACCES as-is (not wrapped in ConfigFileNotFoundError)', async () => {
    const path = await writeYaml('config.yaml', 'port: 9000\n');
    // 000 = no permissions; readFile will EACCES.
    await chmod(path, 0o000);
    // root can read everything, which would make this test silently pass.
    if (process.getuid && process.getuid() === 0) return; // skip under root
    // chmod(0o000) is a no-op for read access on Windows (Node only maps
    // the read-only attribute), so the EACCES this test needs can never
    // fire there -- same silent-pass class as the root case above.
    if (process.platform === 'win32') return;
    await expect(loadFromYaml(path)).rejects.not.toBeInstanceOf(ConfigFileNotFoundError);
    await expect(loadFromYaml(path)).rejects.toThrow(/EACCES|permission/i);
  });

  it('throws via isRecord when the YAML root is not an object (e.g. a scalar)', async () => {
    const path = await writeYaml('config.yaml', 'just-a-string\n');
    await expect(loadFromYaml(path)).rejects.toThrow(/must be an object/);
  });

  // Note: isRecord's check is `typeof === 'object' && !== null`, which
  // ACCEPTS arrays (documented in tests/util/assert.test.ts). So an
  // array-rooted YAML survives loadFromYaml and gets caught downstream
  // by the validator instead. Not a load-time rejection.
});

describe('loadFromYaml: JSON_SCHEMA gating (audit 12 #235)', () => {
  // js-yaml's DEFAULT_SCHEMA parses YAML 1.1 booleans, meaning `on`/`yes`/
  // `y`/`true` all become `true` and `off`/`no`/`n`/`false` all become
  // `false`. That's gibberish for a config field that's supposed to be
  // a string (e.g. LOG_LEVEL: y becomes `true`). JSON_SCHEMA narrows to
  // the JSON-compatible types so these stay as strings.
  it('keeps "yes" as a string, not a boolean', async () => {
    const path = await writeYaml('config.yaml', 'logLevel: yes\n');
    const out = await loadFromYaml(path);
    expect(out.logLevel).toBe('yes');
    expect(out.logLevel).not.toBe(true);
  });

  it('keeps "on" as a string, not a boolean', async () => {
    const path = await writeYaml('config.yaml', 'logLevel: on\n');
    const out = await loadFromYaml(path);
    expect(out.logLevel).toBe('on');
    expect(out.logLevel).not.toBe(true);
  });

  it('still parses literal "true" / "false" as booleans (JSON-compatible)', async () => {
    const path = await writeYaml('config.yaml', 'exposePlexBaseUrl: true\n');
    expect((await loadFromYaml(path)).exposePlexBaseUrl).toBe(true);
  });
});
