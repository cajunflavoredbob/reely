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

// Config layers by priority: env > YAML > defaults. Docker secrets are read
// inside the env layer, not as a layer of their own. `servers` is the one
// exception to the merge; see the spread below.
//
// Validation runs after the merge and MUTATES the result in place.
export async function loadConfig(
  path?: string,
): Promise<[config: Config, errors: ReelyError[]]> {
  const envConfig = await loadFromEnv();
  let yamlConfig: Partial<Config> | undefined;

  try {
    const yamlConfigPath = path ?? join(process.cwd(), 'config.yaml');

    logger.info(`Looking for config in ${yamlConfigPath}`);

    // '/dev/null' is a sentinel that skips the YAML layer, for tests isolating
    // env-only or defaults-only behavior.
    yamlConfig = yamlConfigPath !== '/dev/null'
      ? await loadFromYaml(yamlConfigPath)
      : {};
  } catch (err) {
    // A missing file is tolerable only at the default path (run on
    // env/defaults, warn as unconfigured). An explicit path that's missing is
    // fatal, as is any other error: swallowing it would boot the wrong config.
    if (path || !(err instanceof ConfigFileNotFoundError)) throw err;
  }

  // `servers` is replaced wholesale, never merged by index: an index-merge
  // could pair an env PLEX_TOKEN with a YAML server URL, sending the token to
  // the wrong host.
  const config: Partial<Config> = applyDefaults({
    ...yamlConfig,
    ...envConfig,
  });

  const configErrors = normalizeAndValidateConfig(config);

  // Must run before caching or returning: consumers (including main.ts's debug
  // config dump) log values that contain these. Unconditional, so a config
  // with a bad URL but a valid token still gets the token masked in boot-fail
  // logs.
  registerRedactions(config);

  // Cache only a config that validates, or one whose sole error is "no Plex
  // server" (main.ts boots unconfigured on that). A truly broken config leaves
  // cachedConfig unset so getConfig() throws instead of handing back a
  // half-validated object.
  const blockingErrors = configErrors.filter(
    (e) => e.name !== 'ServersMustNotBeEmpty',
  );
  if (blockingErrors.length === 0) {
    cachedConfig = config as Config;
  }

  return [config as Config, configErrors];
}
