import type { Config } from '../../../../types/reely';
import { readDockerSecret } from './load_secrets';

export type ConfigEnvVariableName =
  | 'PLEX_URL' | 'PLEX_TOKEN' | 'LIBRARY_TITLE_FILTER'
  | 'AUTH_USER' | 'AUTH_PASS' | 'TLS_CERT' | 'TLS_KEY'
  | 'HOST' | 'PORT' | 'LOG_LEVEL' | 'ROOT_PATH' | 'ALLOWED_ORIGINS'
  | 'EXPOSE_PLEX_BASE_URL';

// "a,,b" and "a, b " both yield ["a","b"].
const EnvList = (value: string) =>
  value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

// Throws on anything unrecognized: coercing a typo (EXPOSE_PLEX_BASE_URL=ture)
// to the default would hide the misconfiguration.
const EnvBool = (value: string): boolean => {
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  throw new Error(
    `Env var value ${JSON.stringify(value)} is not a valid boolean ` +
      '(accepts true/false, 1/0, yes/no, on/off, case-insensitive)',
  );
};

// Strips undefined entries so the env spread can't blank out YAML values.
const trimRecord = (value: Record<string, unknown>) => {
  const entries = Object.entries(value).filter(([, v]) => typeof v !== 'undefined');
  if (entries.length !== 0) return Object.fromEntries(entries);
};

const getTrimmedEnv = (
  key: ConfigEnvVariableName,
  Type: typeof String | typeof Number | typeof EnvList | typeof EnvBool = String,
) => {
  const value = process.env[key];
  if (!value) return undefined;
  const parsed = Type(value.trim());
  // Number(non-numeric) is NaN, which would spread into the config and
  // override the default.
  if (Type === Number && !Number.isFinite(parsed as number)) {
    // JSON.stringify escapes the raw value so a hostile PORT lands in the log
    // as a quoted literal.
    throw new Error(`Env var ${key}=${JSON.stringify(value)} is not a valid number`);
  }
  return parsed;
};

// PLEX_URL must carry an explicit scheme. Defaulting to http:// would ship the
// Plex token in cleartext behind a log warning that's easy to miss.
const normalizeUrl = (raw: string | number | boolean | string[] | undefined): string | undefined => {
  if (!raw || typeof raw !== 'string') return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  throw new Error(
    `PLEX_URL "${raw}" has no scheme. Set "http://${raw}" if your Plex ` +
      'server is plain HTTP (LAN), or "https://..." if it supports TLS. ' +
      'The Plex token rides in this URL, so the scheme determines whether ' +
      'it travels encrypted.',
  );
};

export const loadFromEnv = async (): Promise<Partial<Config> | undefined> => {
  // Each bundle is emitted only when both halves of its required pair are set
  // (server needs url+token, basicAuth userName+password, tlsConfig
  // certFile+keyFile). Otherwise setting just one env var emits a half bundle
  // that spreads over the YAML and erases the partner field configured there.
  // Optional fields ride along only once the pair qualifies.
  const url = normalizeUrl(getTrimmedEnv('PLEX_URL'));
  const token = (await readDockerSecret('plex_token')) ?? getTrimmedEnv('PLEX_TOKEN');
  const server = (url && token)
    ? trimRecord({
        url,
        token,
        libraryTitleFilter: getTrimmedEnv('LIBRARY_TITLE_FILTER', EnvList),
      })
    : undefined;

  const authUser = getTrimmedEnv('AUTH_USER');
  const authPass = (await readDockerSecret('auth_pass')) ?? getTrimmedEnv('AUTH_PASS');
  const basicAuth = (authUser && authPass)
    ? { userName: authUser, password: authPass }
    : undefined;

  const certFile = getTrimmedEnv('TLS_CERT');
  const keyFile  = getTrimmedEnv('TLS_KEY');
  const tlsConfig = (certFile && keyFile)
    ? { certFile: certFile as string, keyFile: keyFile as string }
    : undefined;

  return trimRecord({
    hostname:           getTrimmedEnv('HOST'),
    port:               getTrimmedEnv('PORT', Number),
    logLevel:           getTrimmedEnv('LOG_LEVEL'),
    rootPath:           getTrimmedEnv('ROOT_PATH'),
    allowedOrigins:     getTrimmedEnv('ALLOWED_ORIGINS', EnvList),
    exposePlexBaseUrl:  getTrimmedEnv('EXPOSE_PLEX_BASE_URL', EnvBool),
    servers:            server ? [server] : undefined,
    basicAuth,
    tlsConfig,
  }) as Partial<Config> | undefined;
};
