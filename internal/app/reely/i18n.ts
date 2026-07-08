import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request } from 'express';
import accepts from 'accepts';
import { memo, memo1 } from './util/memo';
import type { Translations } from '../../../types/reely';
import { logger } from './logger';

const LOCALIZATION_PATH = join(process.cwd(), 'configs', 'localization');

// Scans the localization directory once and caches the set of available locale codes.
export const getAvailableLocales = memo(async (): Promise<Set<string>> => {
  const availableLocales = new Set<string>();
  const entries = await readdir(LOCALIZATION_PATH, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      availableLocales.add(entry.name.replace('.json', ''));
    }
  }
  return availableLocales;
});

class TranslationLoadError extends Error {}

// A BCP-47-ish locale tag: a 2-3 letter language subtag plus optional
// dash-separated subtags ("en", "en-US", "zh-Hans"). `locale` reaches this
// module from an unauthenticated `setLocale` WebSocket message, and the
// candidate is interpolated into a join() path below -- join() resolves
// `../`, so an unvalidated value would allow reading arbitrary .json files
// off disk. Anything not matching this pattern is dropped before readFile.
const LOCALE_TAG = /^[a-z]{2,3}(-[a-z0-9]+)*$/i;

// Shape check for a parsed locale file (audit 12 #223). The file is JSON,
// but JSON.parse only guarantees valid JSON, not that the value is a flat
// string->string map. A hand-edited file with nested objects or non-string
// values would otherwise leak `[object Object]` / `undefined` into
// translation surfaces. Reject malformed shapes cleanly so the next
// candidate in the fallback chain is tried.
const isTranslationShape = (parsed: unknown): parsed is Record<string, string> => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') return false;
  }
  return true;
};

// Loads and parses a locale file, falling back from full tag ("en-US") to
// language-only ("en") to "en" as a last resort.
//
// Cache caveat (audit 12 #222): `memo1` keys on the input locale string,
// not the candidate that resolved. `loadTranslation('en-US')` and
// `loadTranslation('xx-bogus')` both fall back to en.json but cache under
// their own input keys -- storage duplication but no cross-poisoning,
// since each entry is the same English JSON object. Worth noting if a
// future change ever lets cache entries diverge by input key.
export const loadTranslation = memo1(
  async (locale: string): Promise<Record<string, string>> => {
    const candidates = [...new Set([locale, locale.split('-')[0], 'en'])].filter(
      (candidate) => LOCALE_TAG.test(candidate),
    );
    for (const candidate of candidates) {
      const path = join(LOCALIZATION_PATH, `${candidate}.json`);
      try {
        const text = await readFile(path, 'utf-8');
        const parsed: unknown = JSON.parse(text);
        if (!isTranslationShape(parsed)) {
          logger.warn(
            `Translation file "${path}" is not a flat string->string map; skipping.`,
          );
          continue;
        }
        return parsed;
      } catch (err) {
        // ENOENT is the normal "try the next candidate" case (e.g. "en-US"
        // -> "en" fallback). Anything else (malformed JSON, permission
        // denied) is worth surfacing so a broken locale file doesn't
        // silently fall through to English.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn(
            `Failed to load translation "${path}": ${String(err)}`,
          );
        }
      }
    }
    throw new TranslationLoadError(`No translation file found for locale: ${locale}`);
  },
);

// Resolves the best available locale from the request's Accept-Language header.
export const getTranslations = async (req: Request): Promise<Translations> => {
  const availableLocales = await getAvailableLocales();

  if (!req.headers['accept-language']) {
    // Short-circuit to English. The previous version logged "defaulting to en"
    // but then fell through to accepts(), which returns the first acceptable
    // option in the offer list -- i.e. whatever locale readdir() listed first
    // in availableLocales. The log was a lie.
    // debug, not info: browsers always send Accept-Language, so a header-less
    // request is a non-browser poller -- logging at info would spam the log.
    logger.debug('No Accept-Language header; defaulting to en');
    return (await loadTranslation('en')) as Translations;
  }

  // accepts() reads the IncomingMessage headers directly -- no manual header parsing needed.
  const negotiator = accepts(req);
  // Sort the offer list (audit 12 #249) so the negotiator's tie-breaks are
  // deterministic regardless of the underlying readdir order. accepts ties
  // on q-weight by falling back to the input offer order; readdir's order
  // is filesystem-dependent, so without the sort a same-q request could
  // resolve to different locales on different platforms.
  const acceptedLanguage = negotiator.languages([...availableLocales].sort());

  let language: string;

  if (!acceptedLanguage) {
    language = 'en';
  } else if (Array.isArray(acceptedLanguage)) {
    language = acceptedLanguage[0];
  } else {
    language = acceptedLanguage;
  }

  return (await loadTranslation(language)) as Translations;
};
