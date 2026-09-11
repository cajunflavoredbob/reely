import { join } from 'node:path';
import { logger } from '../logger';
import type { Config } from '../../../../types/reely';
import { applyDefaults } from './defaults';
import { loadFromEnv } from './load_env';
import { loadFromYaml } from './load_yaml';
import { readDockerSecret } from './load_secrets';
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

// Docker secrets are read inside the env layer, where each one is gated on an
// env-var partner: plex_token needs PLEX_URL, auth_pass needs AUTH_USER. A
// partner that lives in config.yaml does not open that gate, so a mounted and
// readable secret used to be dropped on the floor: a YAML server with no token
// failed the boot with "a server token must be specified" while the token sat
// in /run/secrets.
//
// Gaps are filled, never overwritten. A value that survived the merge came
// from a layer that outranks this fallback, and a secret that still has
// nowhere to go is reported rather than dropped in silence.
const fillGapsFromSecrets = async (config: Partial<Config>): Promise<void> => {
  const token = await readDockerSecret('plex_token');
  if (token) {
    const servers = Array.isArray(config.servers) ? config.servers : [];
    // Only with exactly one candidate: handing a token to one of several
    // servers would be guessing which host it belongs to.
    const untokened = servers.filter((server) => server && !server.token);
    if (untokened.length === 1) {
      untokened[0].token = token;
    } else if (!servers.some((server) => server?.token === token)) {
      logger.warn(
        'The plex_token secret file was read but nothing used it. Set ' +
          'PLEX_URL, or remove the token already configured for the server ' +
          'you want it to apply to.',
      );
    }
  }

  const password = await readDockerSecret('auth_pass');
  if (password) {
    const basicAuth = config.basicAuth;
    if (basicAuth?.userName && !basicAuth.password) {
      basicAuth.password = password;
    } else if (basicAuth?.password !== password) {
      logger.warn(
        'The auth_pass secret file was read but nothing used it. Set ' +
          'AUTH_USER, or remove basicAuth.password from config.yaml so the ' +
          'secret supplies it.',
      );
    }
  }
};

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
  // the wrong host. The cost is that any field configured only in YAML goes
  // with it, and a dropped libraryTitleFilter puts every movie library in the
  // deck, so the replacement is named rather than silent.
  if (envConfig?.servers?.length && yamlConfig?.servers?.length) {
    const envKeys = new Set(Object.keys(envConfig.servers[0] ?? {}));
    const dropped = [
      ...new Set(yamlConfig.servers.flatMap((server) => Object.keys(server ?? {}))),
    ].filter((key) => !envKeys.has(key));
    logger.warn(
      'PLEX_URL and PLEX_TOKEN replace the server entry from config.yaml' +
        (dropped.length ? `, dropping its ${dropped.join(', ')}` : '') + '.',
    );
  }

  const config: Partial<Config> = applyDefaults({
    ...yamlConfig,
    ...envConfig,
  });

  await fillGapsFromSecrets(config);

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
