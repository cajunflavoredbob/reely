import type { Config } from '../../../../types/reely';

const defaultServerConfig: Partial<Config["servers"][number]> = {
  type: "plex",
};

const defaultConfig: Partial<Config> = {
  hostname: "0.0.0.0",
  port: 8000,
  logLevel: "INFO",
  rootPath: "",
  servers: [],
  // Preserves 0.3.20 behavior: the WS `config` frame ships `plexBaseUrl`
  // to the browser so it can probe for local-LAN Plex reachability. Flip
  // to false (env EXPOSE_PLEX_BASE_URL=false) to withhold; the frontend
  // then routes all "Open in Plex" links through app.plex.tv. See the
  // shared-type docstring on Config.exposePlexBaseUrl for rationale.
  exposePlexBaseUrl: true,
};

export const applyDefaults = (
  config: Partial<Config>,
): Partial<Config> => {
  const _config = { ...defaultConfig, ...config };
  if (Array.isArray(_config.servers)) {
    _config.servers = _config.servers.map((server) => ({
      ...defaultServerConfig,
      ...server,
    }));
  }
  return _config;
};
