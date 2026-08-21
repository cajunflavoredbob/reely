import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFromYaml } from '../../internal/app/reely/config/load_yaml';
import { ConfigFileNotFoundError } from '../../internal/app/reely/config/errors';

// Real tempdirs rather than a mocked fs: the JSON_SCHEMA gating under test is
// a property of the real js-yaml parser call.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'reely-load-yaml-'));
});

afterEach(async () => {
  // Restore perms or rm fails after the EACCES case.
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
  // Only a genuinely missing file gets ConfigFileNotFoundError, which lets
  // loadConfig fall through to env-only. Everything else propagates with its
  // real cause.
  it('throws ConfigFileNotFoundError on ENOENT', async () => {
    const missing = join(dir, 'nope.yaml');
    await expect(loadFromYaml(missing)).rejects.toBeInstanceOf(ConfigFileNotFoundError);
    await expect(loadFromYaml(missing)).rejects.toThrow(/does not exist/);
  });

  it('propagates EACCES as-is (not wrapped in ConfigFileNotFoundError)', async () => {
    const path = await writeYaml('config.yaml', 'port: 9000\n');
    await chmod(path, 0o000);
    // Root reads anything, so the case cannot arise and the test would pass
    // vacuously.
    if (process.getuid && process.getuid() === 0) return;
    // Same, on Windows: chmod(0o000) only maps the read-only attribute, so
    // EACCES never fires.
    if (process.platform === 'win32') return;
    await expect(loadFromYaml(path)).rejects.not.toBeInstanceOf(ConfigFileNotFoundError);
    await expect(loadFromYaml(path)).rejects.toThrow(/EACCES|permission/i);
  });

  it('throws via isRecord when the YAML root is not an object (e.g. a scalar)', async () => {
    const path = await writeYaml('config.yaml', 'just-a-string\n');
    await expect(loadFromYaml(path)).rejects.toThrow(/must be an object/);
  });

  // isRecord accepts arrays, so an array-rooted YAML survives this stage and
  // is caught by the validator instead.
});

describe('loadFromYaml: JSON_SCHEMA gating', () => {
  // js-yaml's DEFAULT_SCHEMA reads YAML 1.1 booleans, so `logLevel: y` would
  // become `true`. JSON_SCHEMA narrows to JSON types and keeps them strings.
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
