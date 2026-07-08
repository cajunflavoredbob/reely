import type { Config } from '../../../../types/reely';
import { readDockerSecret } from './load_secrets';

export type ConfigEnvVariableName =
  | 'PLEX_URL' | 'PLEX_TOKEN' | 'LIBRARY_TITLE_FILTER'
  | 'AUTH_USER' | 'AUTH_PASS' | 'TLS_CERT' | 'TLS_KEY'
  | 'HOST' | 'PORT' | 'LOG_LEVEL' | 'ROOT_PATH' | 'ALLOWED_ORIGINS'
  | 'EXPOSE_PLEX_BASE_URL';

// Splits a comma-separated env value, trimming each segment and dropping
// empties so "a,,b" or "a, b " yields ["a","b"], not ["a","","b"].
const EnvList = (value: string) =>
  value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

// Parses a boolean env value. Accepts true/1/yes/on (case-insensitive) as
// true; false/0/no/off as false. Anything else throws -- silent coercion
// of a typo'd value to a default would hide misconfiguration (a typo'd
// EXPOSE_PLEX_BASE_URL=ture would otherwise resolve to the default
// instead of surfacing the typo).
const EnvBool = (value: string): boolean => {
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  throw new Error(
    `Env var value ${JSON.stringify(value)} is not a valid boolean ` +
      '(accepts true/false, 1/0, yes/no, on/off, case-insensitive)',
  );
};

// Strips undefined entries so we don't accidentally override YAML config with
// undefined values when merging env config and file config together.
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
  // Number(non-numeric) is NaN, which would then be spread into the partial
  // config and override the default. Fail fast at load time with a clear
  // message instead of letting NaN propagate.
  if (Type === Number && !Number.isFinite(parsed as number)) {
    // JSON.stringify quotes + escapes the raw value (audit 12 #236) so
    // a hostile string like `PORT="<script>..."` lands in logs as a
    // safe literal rather than verbatim characters in the message.
    throw new Error(`Env var ${key}=${JSON.stringify(value)} is not a valid number`);
  }
  return parsed;
};

// Reads supported environment variables and returns a partial Config.
// Environment variables take precedence over the YAML config file (see config/main.ts).
//
// PLEX_URL must include an explicit scheme (audit 12 #207). The prior
// silent downgrade to http:// shipped the Plex token in cleartext with
// only a log warning that's easy to miss in container logs. Forcing the
// operator to type http:// or https:// makes the channel choice explicit.
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
  // Partial-bundle gates (audit 12 #198): each bundle (server, basicAuth,
  // tlsConfig) is only emitted when BOTH halves of its required pair are
  // present. Without the gate, setting only LIBRARY_TITLE_FILTER (or only
  // AUTH_USER, or only TLS_CERT) emits a bundle that spreads over the
  // YAML and erases the partner field already configured there.
  //
  // The "required pair" is the minimum a complete bundle needs:
  //   server    -> { url, token }   (libraryTitleFilter is optional)
  //   basicAuth -> { userName, password }
  //   tlsConfig -> { certFile, keyFile }
  //
  // Anything outside the pair (libraryTitleFilter, etc.) goes in only
  // when the pair already qualifies; otherwise the env contribution to
  // that bundle is dropped entirely.
  //
  // readDockerSecret is async (audit 12 #209) so loadFromEnv is too;
  // loadConfig awaits it. Sequential awaits are fine -- the two secret
  // reads are cheap and run-once at startup.
  const url   = normalizeUrl(getTrimmedEnv('PLEX_URL'));
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
