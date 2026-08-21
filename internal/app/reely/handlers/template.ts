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

// Walks a dotted key path, returning '' as soon as an intermediate node isn't
// an object, so an over-long path can't resolve to its parent's value.
const get = (context: KVP, keyPath: string[]): string => {
  let cur: string | KVP = context;
  for (const key of keyPath) {
    if (typeof cur !== 'object') return '';
    cur = cur[key] ?? '';
  }
  return String(cur);
};

// Replaces every ${key.path} in one pass. The function replacer opts out of
// $&/$1 back-reference interpretation, and one global pass stops a substituted
// value from being rescanned as a placeholder. Every value is escaped here, so
// callers must pass raw values, not pre-escaped ones.
const interpolate = (template: string, context: KVP): string =>
  // Explicit a-zA-Z rather than /i, matching the frontend Tr.interpolate.
  template.replace(
    /\$\{([a-zA-Z0-9_.]+)\}/g,
    (_full, name: string) => escapeHtml(get(context, name.split('.'))),
  );

const getTemplate = memo(() =>
  readFile(join(process.cwd(), 'dist', 'web', 'index.html'), 'utf-8'),
);

// X-Forwarded-Prefix carries the external mount path. It is trusted by design
// (front reely with a proxy and you trust the proxy) and only affects the
// requesting client's own URL prefix. HTML escaping isn't enough on its own:
// the value lands in href/src, where URL parsers don't treat `<` or `..` the
// way attribute escaping does. This allows only what a real path prefix
// contains. It permits `.`, so `..` is excluded separately at the call site.
const ROOT_PATH_ALLOWLIST = /^(\/[A-Za-z0-9._\-/]*)?$/;

const getRootPath = (req: Request, config: Config): string => {
  const forwardedPrefix = req.headers['x-forwarded-prefix'];
  const prefix = Array.isArray(forwardedPrefix)
    ? forwardedPrefix[0]
    : forwardedPrefix;
  // All whitespace, not just edges: internal whitespace is invalid in a URL
  // path and would break the inline script downstream.
  const candidate = (prefix ?? config.rootPath ?? '')
    .replace(/\s+/g, '')
    .replace(/\/$/, '');
  // A rejected prefix boots the app with no rootPath, so the operator sees
  // the misconfiguration immediately.
  if (candidate.includes('..')) return '';
  return ROOT_PATH_ALLOWLIST.test(candidate) ? candidate : '';
};

export const handler = async (req: Request, res: Response): Promise<void> => {
  const config = getConfig();
  const translations = await getTranslations(req);
  const template = await getTemplate();

  res.setHeader('Content-Type', 'text/html');
  // The shell must revalidate or a deploy serves stale markup pointing at
  // asset filenames that no longer exist.
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).send(
    // Never pass the full config: it holds the Plex token. Values go in raw;
    // interpolate() escapes them.
    interpolate(template, {
      ...translations,
      rootPath: getRootPath(req, config),
      version: await getVersion(),
    }),
  );
};
