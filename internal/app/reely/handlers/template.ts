import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { memo } from '../util/memo';
import { getTranslations } from '../i18n';
import { getConfig } from '../config/main';
import type { Config } from '../../../../types/reely';
import { getVersion } from '../version';

type KVP = { [key: string]: string | KVP };

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// Walks a dotted key path through a nested object, returning the value as
// a string. Returns '' the moment any intermediate node isn't an object --
// the prior reduce form would silently substitute the parent string when a
// later segment ran off the end (audit 10 #168). e.g. with context
// `{ a: "x" }` and keyPath `['a', 'b']` the old code returned "x"; this
// version returns ''.
const get = (context: KVP, keyPath: string[]): string => {
  let cur: string | KVP = context;
  for (const key of keyPath) {
    if (typeof cur !== 'object') return '';
    cur = cur[key] ?? '';
  }
  return String(cur);
};

// Replaces every ${key.path} placeholder with its resolved, HTML-escaped
// value in a single regex pass. The function-replacer form opts out of
// String.replace's special $&/$1/etc. back-reference interpretation, and a
// single global pass avoids the old per-match loop's bug -- that loop
// re-scanned the mutated string with replace(match, ...), so a value
// containing another placeholder's literal text could be substituted into
// the wrong spot. Every value is escaped here (translations included), so
// callers must pass raw values, not pre-escaped ones.
const interpolate = (template: string, context: KVP): string =>
  // Explicit `a-zA-Z` rather than `a-z` + `/i` -- the `/i` flag did the
  // right thing (matching uppercase too) but the lowercase-only char
  // class read like a bug. The frontend `Tr.interpolate` (0.4.3 #144)
  // uses the same convention.
  template.replace(
    /\$\{([a-zA-Z0-9_.]+)\}/g,
    (_full, name: string) => escapeHtml(get(context, name.split('.'))),
  );

const getTemplate = memo(() =>
  readFile(join(process.cwd(), 'dist', 'web', 'index.html'), 'utf-8'),
);

// X-Forwarded-Prefix is non-standard but widely used by reverse proxies to
// communicate the prefix path at which the app is mounted externally. It is
// trusted unconditionally by design -- consistent with the rateLimit
// proxy-trust caveat: if you front reely with a proxy, you trust it. The
// value is HTML-escaped before use and only sets the requesting client's own
// WS/poster URL prefix, so a hostile value is self-contained (no leak, no
// cross-client effect).
// Tighter allowlist for the path-prefix charset (audit 12 #224). Even
// with HTML-escaping at substitution time, a hostile proxy header that
// lands in an `href`/`src` URL context could deliver characters like
// `..`, `<`, `>` that aren't escaped by URL parsers the way they are by
// HTML attribute escaping. The allowlist matches what a legitimate URL
// path prefix would ever contain: forward slashes + URL-safe ASCII.
//
// The allowlist character class permits `.` (legit URL path char) so the
// regex alone can't block `..`. Surfaced by a 0.4.27 test: `/../system`
// passes the regex even though the audit-12 #224 comment specifically
// called out `..` as the concern. Belt-and-suspenders: explicit `..`
// exclusion at the call site below.
const ROOT_PATH_ALLOWLIST = /^(\/[A-Za-z0-9._\-/]*)?$/;

const getRootPath = (req: Request, config: Config): string => {
  const forwardedPrefix = req.headers['x-forwarded-prefix'];
  const prefix = Array.isArray(forwardedPrefix)
    ? forwardedPrefix[0]
    : forwardedPrefix;
  // Strip ALL whitespace (not just edges) -- a path prefix containing
  // internal whitespace is invalid in any URL, so silently dropping it
  // keeps a misconfigured proxy from producing weird inline-script
  // breakage downstream (audit 9 #161).
  const candidate = (prefix ?? config.rootPath ?? '')
    .replace(/\s+/g, '')
    .replace(/\/$/, '');
  // Charset gate (audit 12 #224) + explicit `..` exclusion. A hostile
  // header that survives the proxy chain doesn't get to land in the
  // template; the app boots without a rootPath and the operator sees
  // the misconfiguration immediately. The `..` check is separate from
  // the allowlist because the allowlist's char class permits `.`
  // (legit URL path char), so it can't block consecutive dots via
  // regex alone without a non-trivial lookahead.
  if (candidate.includes('..')) return '';
  return ROOT_PATH_ALLOWLIST.test(candidate) ? candidate : '';
};

export const handler = async (req: Request, res: Response): Promise<void> => {
  const config = getConfig();
  const translations = await getTranslations(req);
  const template = await getTemplate();

  res.setHeader('Content-Type', 'text/html');
  // The HTML shell is small and references hashed assets that cache fine.
  // Force the entry point itself to revalidate so a deploy never serves stale
  // bootstrap markup pointing at non-existent old asset filenames.
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).send(
    // Only version + rootPath are referenced by the HTML shell. The full
    // config (which includes the Plex token) is deliberately NOT passed into
    // the interpolation context. Values are passed raw -- interpolate()
    // HTML-escapes every substitution itself.
    interpolate(template, {
      ...translations,
      rootPath: getRootPath(req, config),
      version: await getVersion(),
    }),
  );
};
