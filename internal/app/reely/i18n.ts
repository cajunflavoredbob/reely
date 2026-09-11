import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request } from 'express';
import accepts from 'accepts';
import { memo, memo1 } from './util/memo';
import type { Translations } from '../../../types/reely';
import { logger } from './logger';

const LOCALIZATION_PATH = join(process.cwd(), 'configs', 'localization');

// Scans the localization dir once; caches the available locale codes.
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

// BCP-47-ish locale tag ("en", "en-US", "zh-Hans"). `locale` arrives from an
// unauthenticated setLocale WS message and is interpolated into a join() path
// below, which resolves `../`: unvalidated, it reads arbitrary .json off disk.
//
// Subtags are bounded at 8 characters, the BCP-47 maximum, and the whole tag
// at 35. Without a bound the tag is only as long as the sender cares to make
// it: readFile then fails ENAMETOOLONG rather than ENOENT, and the non-ENOENT
// branch below writes the entire caller-chosen path back out as a warn line.
const MAX_LOCALE_TAG_LENGTH = 35;
const LOCALE_TAG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i;

const isLocaleTag = (candidate: string): boolean =>
  candidate.length <= MAX_LOCALE_TAG_LENGTH && LOCALE_TAG.test(candidate);

// JSON.parse proves valid JSON, not a flat string->string map. Nested objects
// or non-string values would leak `[object Object]` into translated surfaces;
// rejecting lets the next candidate in the fallback chain be tried.
const isTranslationShape = (parsed: unknown): parsed is Record<string, string> => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  for (const v of Object.values(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') return false;
  }
  return true;
};

// Loads a locale file, falling back from full tag ("en-US") to language-only
// ("en") to "en".
//
// memo1 keys on the input locale, not the candidate that resolved, so several
// inputs falling back to en.json each cache their own copy. Harmless while the
// entries are identical.
export const loadTranslation = memo1(
  async (locale: string): Promise<Record<string, string>> => {
    const candidates = [...new Set([locale, locale.split('-')[0], 'en'])].filter(
      isLocaleTag,
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
        // ENOENT is the normal "try the next candidate" case. Malformed JSON
        // or EACCES must not silently fall through to English.
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

// Resolves the best available locale from Accept-Language. Split out from
// getTranslations because the HTML shell needs the tag itself, not just the
// bundle: a document that renders German while declaring `lang="en"` gets
// English phonemes from a screen reader and a translation prompt from Chrome.
export const resolveLanguage = async (req: Request): Promise<string> => {
  const availableLocales = await getAvailableLocales();

  if (!req.headers['accept-language']) {
    // Short-circuit: accepts() with no header returns the first offer, not en.
    // debug, not info: a header-less request is a poller, and info would spam.
    logger.debug('No Accept-Language header; defaulting to en');
    return 'en';
  }

  const negotiator = accepts(req);
  // Sort the offers: accepts breaks q-weight ties by offer order, and
  // readdir's order is filesystem-dependent.
  const acceptedLanguage = negotiator.languages([...availableLocales].sort());

  if (!acceptedLanguage) return 'en';
  if (Array.isArray(acceptedLanguage)) return acceptedLanguage[0];
  return acceptedLanguage;
};

export const getTranslations = async (req: Request): Promise<Translations> =>
  (await loadTranslation(await resolveLanguage(req))) as Translations;
