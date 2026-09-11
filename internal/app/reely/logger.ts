import pino from 'pino';

// Config-facing level names to pino's. The user-facing spellings (WARNING,
// CRITICAL) are kept so existing config.yaml and LOG_LEVEL values still work.
const LOG_LEVEL_MAP: Record<string, pino.Level> = {
  DEBUG:    'debug',
  INFO:     'info',
  WARNING:  'warn',
  ERROR:    'error',
  CRITICAL: 'fatal',
};

// Values masked in all log output; call addRedaction() when a sensitive value
// (Plex token, server URL) is first seen.
//
// Never pruned: entries live for the process lifetime. Fine while config does
// not hot-reload, but a hot-reload feature needs an eviction policy here.
const redactions: string[] = [];

// Compiled pattern for all current redactions; rebuilt lazily after addRedaction.
let redactionPattern: RegExp | null = null;
// Escape metacharacters so a "?" or "+" in a value matches literally.
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Not gated by log level: pino filters after the wrapper hands the message in,
// and a transport at a lower threshold could still write it.
//
// No anchors or word boundaries, deliberately. Tokens and URLs appear inside
// query strings, JSON payloads and fetch URLs, none of them on a word
// boundary; substring matching is the intended semantics.
function applyRedactions(msg: string): string {
  if (redactions.length === 0) return msg;
  if (!redactionPattern) {
    redactionPattern = new RegExp(redactions.map(escapeRegex).join('|'), 'g');
  }
  return msg.replace(redactionPattern, '****');
}

// pino-pretty in development, NDJSON in production.
//
// Default 'info', not 'debug': this level applies until setLogLevel runs after
// loadConfig, and debug there would spam startup for an INFO-level operator.
const createLogger = (): pino.Logger => {
  if (process.env.NODE_ENV === 'production') return pino({ level: 'info' });
  try {
    return pino({
      level: 'info',
      transport: { target: 'pino-pretty', options: { colorize: true } },
    });
  } catch {
    // pino-pretty is a devDependency and the published image ships only the
    // prod tree, so asking for the transport there throws synchronously while
    // this module is still being imported: before main.ts's try/catch and
    // before the redacting logger exists, which turns `NODE_ENV=development`
    // on the image into an immediate crash with a raw stack and no diagnostic.
    // Plain NDJSON is always available.
    return pino({ level: 'info' });
  }
};

const _logger = createLogger();

// Public logger. Every message passes through applyRedactions() before pino.
export const logger = {
  debug: (msg: string) => _logger.debug(applyRedactions(msg)),
  info:  (msg: string) => _logger.info(applyRedactions(msg)),
  warn:  (msg: string) => _logger.warn(applyRedactions(msg)),
  error: (msg: string) => _logger.error(applyRedactions(msg)),
  fatal: (msg: string) => _logger.fatal(applyRedactions(msg)),
};

export const setLogLevel = (level: string) => {
  const pinoLevel = LOG_LEVEL_MAP[level];
  if (pinoLevel) _logger.level = pinoLevel;
};

// Development-only escape hatch for debugging token/URL issues. Setting it in
// production exposes Plex tokens in logs.
const REDACTIONS_DISABLED =
  process.env.UNADVISABLY_DISABLE_LOG_REDACTIONS === 'please';

export const addRedaction = (value: string) => {
  if (REDACTIONS_DISABLED || !value) return;
  // Matching is literal substring, so register every form the value can take
  // in a log line: raw, URL-encoded (query params encode + / =), and
  // JSON-escaped (main.ts dumps the config via JSON.stringify, which rewrites
  // `"` and `\`). slice(1, -1) strips the quotes JSON.stringify adds.
  let changed = false;
  const forms = new Set([
    value,
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]);
  for (const form of forms) {
    if (form && !redactions.includes(form)) {
      redactions.push(form);
      changed = true;
    }
  }
  // Invalidate so applyRedactions rebuilds with the new value.
  if (changed) redactionPattern = null;
};
