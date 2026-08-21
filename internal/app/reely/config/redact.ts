import { addRedaction } from '../logger';
import type { Config } from '../../../../types/reely';

/**
 * Registers every Config value the logger should mask. Each field is
 * type-checked independently so a config that failed validation still gets
 * its well-formed secrets redacted. Idempotent: addRedaction dedupes.
 *
 * Separate from validate.ts so the validator stays a pure
 * `(unknown) -> ReelyError[]` and the logger coupling lives in one place.
 */
export const registerRedactions = (config: Partial<Config>): void => {
  if (Array.isArray(config.servers)) {
    for (const server of config.servers) {
      if (typeof server?.url === 'string' && server.url.length > 0) {
        // A value that won't parse as a URL never reaches log output, so
        // registering it would waste a redaction slot.
        try {
          new URL(server.url);
          addRedaction(server.url);
        } catch { /* skip */ }
      }
      if (typeof server?.token === 'string' && server.token.length > 0) {
        addRedaction(server.token);
      }
    }
  }

  // Boot logs the whole config at DEBUG, so the password needs masking too.
  if (typeof config.basicAuth?.password === 'string' && config.basicAuth.password.length > 0) {
    addRedaction(config.basicAuth.password);
  }
};
