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
//
// The value is named, never echoed: this throw is reported at fatal before
// registerRedactions has run, so echoing it would put the operator's Plex
// address in cleartext in the one log line that gets pasted into bug reports.
const normalizeUrl = (raw: string | number | boolean | string[] | undefined): string | undefined => {
  if (!raw || typeof raw !== 'string') return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  throw new Error(
    'PLEX_URL has no scheme. Prefix the address with "http://" if your Plex ' +
      'server is plain HTTP (LAN), or "https://" if it supports TLS. ' +
      'The Plex token rides in this URL, so the scheme determines whether ' +
      'it travels encrypted.',
  );
};

// getTrimmedEnv collapses a present-but-empty var into "unset" so that a blank
// line in a .env file reads as "not configured". For one half of a pair that
// collapse is a silent downgrade: AUTH_PASS= beside a real AUTH_USER drops the
// whole basicAuth bundle and the server boots with authentication off, with
// nothing in the log to say so. readDockerSecret answers the same question the
// same way for an empty secret file: an operator who supplied the name is
// misconfigured, not opting out.
const rejectHalfBlankPair = (
  first: { key: ConfigEnvVariableName; value: unknown },
  second: { key: ConfigEnvVariableName; value: unknown },
): void => {
  for (const [set, blank] of [[first, second], [second, first]] as const) {
    if (!set.value || blank.value) continue;
    // undefined?.trim() is undefined, so an unset partner never matches here:
    // only a var that was supplied and left empty does.
    if (process.env[blank.key]?.trim() !== '') continue;
    throw new Error(
      `${blank.key} is set to an empty value while ${set.key} has one. Give ` +
        `${blank.key} a value, or remove it so the pair reads as ` +
        'deliberately unconfigured.',
    );
  }
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
  // Both halves of this pair, and of the TLS pair below, turn a blank value
  // into a downgrade the operator cannot see (no auth, plain HTTP). The Plex
  // pair is left alone on purpose: a half-blank one boots to the "reely is not
  // configured" notice, which already names both vars.
  rejectHalfBlankPair(
    { key: 'AUTH_USER', value: authUser },
    { key: 'AUTH_PASS', value: authPass },
  );
  const basicAuth = (authUser && authPass)
    ? { userName: authUser, password: authPass }
    : undefined;

  const certFile = getTrimmedEnv('TLS_CERT');
  const keyFile  = getTrimmedEnv('TLS_KEY');
  rejectHalfBlankPair(
    { key: 'TLS_CERT', value: certFile },
    { key: 'TLS_KEY', value: keyFile },
  );
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
