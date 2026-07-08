import { readFile } from 'node:fs/promises';

// Docker compose / Swarm mount secrets under /run/secrets; some Kubernetes
// configurations use /var/run/secrets or a custom path. Honor SECRETS_DIR
// when set so the same image works across orchestrators.
const SECRETS_DIR = process.env.SECRETS_DIR ?? '/run/secrets';

export class EmptyDockerSecretError extends Error {
  name = 'EmptyDockerSecretError';
}

// Reads a Docker secret from <SECRETS_DIR>/<name>.
//   - Returns trimmed file contents if the file exists and is non-empty.
//   - Returns undefined if the file does not exist (the orchestrator never
//     mounted it -- the caller falls back to env vars).
//   - Throws EmptyDockerSecretError if the file exists but is empty /
//     whitespace-only (audit 12 #199): an operator who mounted a secret
//     and then left it blank is misconfigured, not opting out -- silently
//     falling back to env would ship the empty value through and confuse
//     "auth bypassed" with "auth not configured".
//   - Re-throws any other read error (permission denied, etc.).
//
// Async (audit 12 #209): the loader is already async, so we use
// `fs.promises.readFile` instead of `readFileSync` to avoid blocking the
// event loop. Single read + try/catch on ENOENT replaces the prior
// `existsSync` + `readFileSync` split (audit 11 #188 / audit 12 #208 TOCTOU).
export const readDockerSecret = async (name: string): Promise<string | undefined> => {
  const path = `${SECRETS_DIR}/${name}`;
  let content: string;
  try {
    content = (await readFile(path, 'utf-8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (!content) {
    throw new EmptyDockerSecretError(
      `Docker secret file ${path} is empty. Either populate it or remove ` +
        `the secret mount so the env-var fallback is used.`,
    );
  }
  return content;
};
