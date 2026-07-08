import { addRedaction } from '../logger';
import type { Config } from '../../../../types/reely';

/**
 * Walks a (validated or partially-validated) Config and registers every
 * value the logger should mask. Each field is defensively type-checked,
 * so a config that the validator collected errors on still gets its
 * well-typed bits registered -- the validator's own fail-fast doesn't
 * abort the registration of fields that are individually fine.
 *
 * Idempotent: addRedaction dedupes internally, so re-calling for the
 * same value is free (PlexApi's constructor also registers its own
 * URL+token for defense-in-depth -- 0.4.5 #162).
 *
 * The validator (validate.ts) used to do this inline. Extracted in
 * 0.4.16 (audit 12 #237 + #276) so the validator is a pure
 * `(unknown) -> ReelyError[]` and the logger coupling lives in one
 * explicit place instead of being scattered through validator
 * field-walks.
 */
export const registerRedactions = (config: Partial<Config>): void => {
  if (Array.isArray(config.servers)) {
    for (const server of config.servers) {
      if (typeof server?.url === 'string' && server.url.length > 0) {
        // Skip values that obviously won't parse as URLs -- a malformed
        // value never appears in legitimate log output, and registering
        // it would waste a redaction slot. Mirrors the validator's
        // URL-parse gate (audit 10 #143).
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

  // basicAuth.password is NEW in 0.4.16. Previously unredacted: a small
  // but real gap, since cmd/reely/main.ts:103 does logger.debug(
  // JSON.stringify(config)) at boot, and the password was riding
  // through that at DEBUG level. Now registered alongside the Plex
  // token.
  if (typeof config.basicAuth?.password === 'string' && config.basicAuth.password.length > 0) {
    addRedaction(config.basicAuth.password);
  }
};
