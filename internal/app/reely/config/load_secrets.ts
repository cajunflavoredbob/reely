import { readFile } from 'node:fs/promises';

// Compose and Swarm use /run/secrets; Kubernetes may use another path.
// SECRETS_DIR lets one image work across orchestrators.
const SECRETS_DIR = process.env.SECRETS_DIR ?? '/run/secrets';

export class EmptyDockerSecretError extends Error {
  name = 'EmptyDockerSecretError';
}

// Reads <SECRETS_DIR>/<name>, trimmed. Missing file returns undefined so the
// caller falls back to env vars. A file that exists but is blank throws: the
// operator is misconfigured, not opting out, and falling back would let
// "auth bypassed" pass for "auth not configured". Other errors propagate.
//
// One read plus ENOENT rather than exists-then-read, which is a TOCTOU race.
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
