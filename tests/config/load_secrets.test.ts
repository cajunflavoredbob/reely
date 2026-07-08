import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// readDockerSecret reads from process.env.SECRETS_DIR (default /run/secrets).
// Tests redirect SECRETS_DIR to a per-test tmpdir so file fixtures can be
// laid down without root.
//
// vi.resetModules() + dynamic import per test because the SECRETS_DIR
// constant is captured at module load.

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
    // No file written -- the orchestrator never mounted this secret, so
    // the caller falls back to the env-var path.
    const { readDockerSecret } = await reload();
    await expect(readDockerSecret('plex_token')).resolves.toBeUndefined();
  });

  // Audit 12 #199: an operator who mounted a secret and then left the file
  // empty is misconfigured, not opting out. 0.4.8 throws instead of
  // silently falling back to env (which would mask "auth bypassed" as
  // "auth not configured").
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
