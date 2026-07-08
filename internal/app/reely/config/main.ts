import { join } from 'node:path';
import { logger } from '../logger';
import type { Config } from '../../../../types/reely';
import { applyDefaults } from './defaults';
import { loadFromEnv } from './load_env';
import { loadFromYaml } from './load_yaml';
import { normalizeAndValidateConfig } from './validate';
import { registerRedactions } from './redact';
import { ConfigFileNotFoundError } from './errors';
import type { ReelyError } from '../util/assert';

let cachedConfig: Config;

export function getConfig(): Config {
  if (!cachedConfig) {
    throw new Error('getConfig was called before the config was loaded.');
  }
  return cachedConfig;
}

// Config layers, in PRIORITY order (audit 12 #272):
//   1. ENV vars (top priority) -- loadFromEnv reads PLEX_URL, AUTH_PASS,
//      ALLOWED_ORIGINS, etc. Docker secrets are read INSIDE this layer
//      (load_secrets.ts is a helper, not a separate layer) for the two
//      sensitive values (plex_token, auth_pass) that can be mounted as
//      files instead of env vars.
//   2. YAML file (config.yaml or --config <path>) -- loadFromYaml.
//   3. defaults (defaults.ts) -- hostname=0.0.0.0, port=8000, etc.
// The merge is "later layers fill in gaps": env > yaml > defaults. `servers`
// is the one exception -- if env defines a server at all, the env server
// replaces the yaml server outright (see comment on the spread below).
//
// Validation runs after the merge and may MUTATE the merged config in place
// (port coercion, logLevel uppercase) -- see normalizeAndValidateConfig.
export async function loadConfig(
  path?: string,
): Promise<[config: Config, errors: ReelyError[]]> {
  const envConfig = await loadFromEnv();
  let yamlConfig: Partial<Config> | undefined;

  try {
    const yamlConfigPath = path ?? join(process.cwd(), 'config.yaml');

    logger.info(`Looking for config in ${yamlConfigPath}`);

    // Sentinel: passing '/dev/null' as the config path skips the YAML load
    // entirely (used by tests that want to isolate env-only / defaults-only
    // behavior). Production callers pass a real path or omit the argument.
    yamlConfig = yamlConfigPath !== '/dev/null'
      ? await loadFromYaml(yamlConfigPath)
      : {};
  } catch (err) {
    // A *missing* file is acceptable only when falling back to the default
    // path -- the server then runs on env/defaults and shows an unconfigured
    // warning. An explicitly-specified missing path is fatal. Any other error
    // (malformed YAML, EACCES, EISDIR) is always fatal: swallowing it would
    // hide a real config problem and silently start with the wrong config.
    if (path || !(err instanceof ConfigFileNotFoundError)) throw err;
  }

  // Env config overrides YAML config wholesale. `servers` is NOT merged by
  // index: reely is single-server, and a per-field index-merge could attach
  // an env PLEX_TOKEN to a YAML server URL it was never meant to pair with
  // (token sent to the wrong host). If env defines a server at all, the env
  // server replaces the YAML one outright -- the `...envConfig` spread does
  // exactly that.
  const config: Partial<Config> = applyDefaults({
    ...yamlConfig,
    ...envConfig,
  });

  const configErrors = normalizeAndValidateConfig(config);

  // Register redactions for sensitive values BEFORE caching the config or
  // returning -- once cached, getConfig() consumers (and main.ts's debug
  // config dump at cmd/reely/main.ts) may log values that include these.
  // Run unconditionally rather than gating on blockingErrors: the redact
  // function is field-wise defensive, and a config with errors on, say,
  // the URL but a valid token still benefits from token redaction in any
  // boot-fail logs. (Extracted from validate.ts in 0.4.16 -- audit 12
  // #237 + #276.)
  registerRedactions(config);

  // Only cache the config when it passes validation -- or when the only
  // remaining error is the "no Plex server" case, which main.ts handles as
  // a runtime warning + boot in unconfigured mode (not a fatal). A truly
  // broken config (port: "abc", malformed YAML, etc.) leaves cachedConfig
  // unset, so a downstream `getConfig()` call throws "called before the
  // config was loaded" instead of returning the half-validated object.
  const blockingErrors = configErrors.filter(
    (e) => e.name !== 'ServersMustNotBeEmpty',
  );
  if (blockingErrors.length === 0) {
    cachedConfig = config as Config;
  }

  return [config as Config, configErrors];
}
