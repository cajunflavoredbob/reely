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
  // Ships plexBaseUrl in the WS config frame so the browser can probe for a
  // LAN-reachable Plex. False routes "Open in Plex" via app.plex.tv instead.
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
