import pino from 'pino';

/**
 * Maps the config-facing log level names to pino's level names.
 * We keep the original user-facing names (DEBUG, WARNING, CRITICAL) so that
 * existing config.yaml files and LOG_LEVEL env vars continue to work unchanged.
 */
const LOG_LEVEL_MAP: Record<string, pino.Level> = {
  DEBUG:    'debug',
  INFO:     'info',
  WARNING:  'warn',
  ERROR:    'error',
  CRITICAL: 'fatal',
};

// Values registered here are masked in all log output. addRedaction() should
// be called any time a sensitive value (Plex token, server URL) is first seen,
// ensuring it cannot leak into log files or stdout and making logs safe to share.
//
// Not pruned across config reloads (audit 12 #221): once a token has been
// observed it stays in the redaction set for the lifetime of the process.
// Acceptable because (a) reely doesn't reload config at runtime today, so
// the list grows by ~1 entry per startup -- bounded and not under attacker
// control; (b) redacting stale tokens never harms anything -- it just
// means we won't accidentally print one if it shows up later. If a future
// hot-reload feature lands, this set needs an eviction policy at the same
// time.
const redactions: string[] = [];

// Cached compiled regex of all current redactions. Rebuilt lazily on the
// next applyRedactions call after addRedaction mutates the list.
let redactionPattern: RegExp | null = null;
// Escape the regex metacharacters so a raw "?", "+", etc. in a value is
// matched literally instead of interpreted.
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Runs unconditionally (not gated by log level) because pino's level filter
// happens AFTER our wrapper passes the message in; we have to redact before
// the message could be written. Keeping it eager also means a redacted value
// can't slip out via a transport that runs at a lower threshold.
//
// Previously did `redactions.reduce(s.split.join)` -- O(N * L) per message
// where N is values * L is message length. Switched to a single combined
// regex pass (audit 9 #145). N is small today (~2) but the old shape
// scaled poorly if a future code path registered many values.
//
// No anchoring or word boundaries on the pattern (audit 14 #361): a
// registered value like `abc123` matches inside any longer string. That's
// deliberate -- the URL-encoded form of the same value is ALSO registered
// (see addRedaction), and tokens / URLs appear inside query strings,
// JSON-encoded log payloads, fetch URLs, etc., none of which sit on a
// word boundary. Substring matching is the correct semantics for "mask
// any occurrence of this sensitive value, wherever it appears."
function applyRedactions(msg: string): string {
  if (redactions.length === 0) return msg;
  if (!redactionPattern) {
    redactionPattern = new RegExp(redactions.map(escapeRegex).join('|'), 'g');
  }
  return msg.replace(redactionPattern, '****');
}

// In development: pino-pretty for human-readable, colorized output.
// In production: newline-delimited JSON for structured log aggregation.
//
// Default level is 'info' (audit 12 #258) -- `setLogLevel(config.logLevel)`
// runs after loadConfig and can drop it to 'debug' for the DEBUG-level
// operator config. The prior default of 'debug' meant every startup
// printed debug lines before setLogLevel landed, which spammed the
// container log for the operator config that wanted INFO.
const _logger = pino({
  level: 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

// Public logger. All messages pass through applyRedactions() before reaching
// pino so sensitive values are never written to output under any circumstance.
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

// Set UNADVISABLY_DISABLE_LOG_REDACTIONS=please to turn off redaction.
// This exists solely for debugging token/URL issues during development.
// Never set this in production -- doing so will expose Plex tokens in logs.
const REDACTIONS_DISABLED =
  process.env.UNADVISABLY_DISABLE_LOG_REDACTIONS === 'please';

export const addRedaction = (value: string) => {
  if (REDACTIONS_DISABLED || !value) return;
  // Register the raw value AND its URL-encoded form. A Plex token or URL is
  // carried in request URLs as a query-param value, which url-encodes it --
  // applyRedactions does literal substring matching, so without the encoded
  // form an encodable character (e.g. + / =) would slip through into logs.
  //
  // ALSO register the JSON-escaped form (audit 16 #441): main.ts dumps the
  // whole config via JSON.stringify at DEBUG on the explicit premise that
  // "redaction is the guard here", but JSON escaping rewrites `"` and `\`
  // inside string values (my"pass -> my\"pass), so a password containing
  // either character matched neither registered form and printed in full.
  // JSON.stringify(value).slice(1, -1) is the escaped body without the
  // surrounding quotes; the Set dedupes it away when identical to the raw.
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
  // Invalidate the compiled regex so applyRedactions rebuilds it on the
  // next call to include the newly-registered value.
  if (changed) redactionPattern = null;
};
