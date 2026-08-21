import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SECRETS_DIR is redirected to a tmpdir so fixtures need no root. It is
// captured at module load, hence resetModules plus a dynamic import per test.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reely-secrets-'));
  process.env.SECRETS_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SECRETS_DIR;
});

const reload = async () => {
  const { vi } = await import('vitest');
  vi.resetModules();
  return await import('../../internal/app/reely/config/load_secrets');
};

describe('readDockerSecret', () => {
  it('returns trimmed file contents when the secret exists', async () => {
    writeFileSync(join(dir, 'plex_token'), '  abc123  \n');
    const { readDockerSecret } = await reload();
    await expect(readDockerSecret('plex_token')).resolves.toBe('abc123');
  });

  it('returns undefined when the secret file does not exist (ENOENT)', async () => {
    // Nothing written: the secret was never mounted, so the caller falls back
    // to the env var.
    const { readDockerSecret } = await reload();
    await expect(readDockerSecret('plex_token')).resolves.toBeUndefined();
  });

  // A mounted-but-empty secret is misconfiguration, not opt-out. Falling back
  // to env would mask "auth bypassed" as "auth not configured".
  it('throws EmptyDockerSecretError on an empty secret file', async () => {
    writeFileSync(join(dir, 'plex_token'), '');
    const { readDockerSecret, EmptyDockerSecretError } = await reload();
    await expect(readDockerSecret('plex_token')).rejects.toThrow(EmptyDockerSecretError);
  });

  it('throws EmptyDockerSecretError on a whitespace-only secret file', async () => {
    writeFileSync(join(dir, 'plex_token'), '   \n\t  \n');
    const { readDockerSecret, EmptyDockerSecretError } = await reload();
    await expect(readDockerSecret('plex_token')).rejects.toThrow(EmptyDockerSecretError);
  });
});
