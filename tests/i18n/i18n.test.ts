import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

// getTranslations references getAvailableLocales / loadTranslation via
// closure inside the i18n module, so vi.mock with importOriginal wouldn't
// re-route those internal calls. Instead we run against the real
// configs/localization/ directory; the JSON files are checked into the repo
// and contain a stable set of locales (en, de, es, fr, nl, pl).
import { getTranslations, loadTranslation } from '../../internal/app/reely/i18n';

// Local to this file; distinct shape from helpers.ts's `makeReq`
// (which stubs `socket.remoteAddress` for rate-limit tests). Renamed to
// avoid the shadowing flagged by audit 13 #339 -- the shared helper
// keys on a different field, so a future contributor could import the
// shared one and get a request without an Accept-Language header.
const makeAcceptLanguageReq = (acceptLanguage?: string): Request =>
  ({
    headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {},
  } as unknown as Request);

// Each locale's FILTERS_LOADING string is distinct, so we use it as the
// signal that the negotiation picked the file we expected.
const FILTERS_LOADING_BY_LOCALE = {
  en: 'Loading filters...',
  de: 'Filter werden geladen...',
  es: 'Cargando filtros...',
  fr: 'Chargement des filtres...',
  nl: 'Filters laden...',
  pl: 'Ładowanie filtrów...',
} as const;

const expectLocale = (t: Record<string, string>, code: keyof typeof FILTERS_LOADING_BY_LOCALE) =>
  expect(t.FILTERS_LOADING).toBe(FILTERS_LOADING_BY_LOCALE[code]);

describe('getTranslations Accept-Language negotiation', () => {
  it('picks an exact match', async () => {
    const t = await getTranslations(makeAcceptLanguageReq('de'));
    expectLocale(t as unknown as Record<string, string>, 'de');
  });

  it('falls back from en-US to en', async () => {
    const t = await getTranslations(makeAcceptLanguageReq('en-US,en;q=0.9'));
    expectLocale(t as unknown as Record<string, string>, 'en');
  });

  it('respects q-weighted preference order', async () => {
    // German has the highest q; should win even though English appears first.
    const t = await getTranslations(makeAcceptLanguageReq('en;q=0.5,de;q=1.0'));
    expectLocale(t as unknown as Record<string, string>, 'de');
  });

  it('defaults to en when Accept-Language header is missing', async () => {
    const t = await getTranslations(makeAcceptLanguageReq(undefined));
    expectLocale(t as unknown as Record<string, string>, 'en');
  });

  it('defaults to en when no requested locale is available', async () => {
    // Klingon is not in configs/localization/.
    const t = await getTranslations(makeAcceptLanguageReq('tlh'));
    expectLocale(t as unknown as Record<string, string>, 'en');
  });
});

describe('loadTranslation path-traversal guard', () => {
  // `setLocale` is an unauthenticated WS message; its language string flows
  // straight into loadTranslation. Without validation, join() resolving `../`
  // would let it read any .json on disk (e.g. data/rooms/*.json). A traversal
  // payload must be rejected and fall through to the safe `en` default.
  it('falls back to en for a `../`-traversal locale', async () => {
    // Unguarded, this resolves to <cwd>/package.json -- which parses as JSON
    // but has no FILTERS_LOADING key, so expectLocale would fail.
    const t = await loadTranslation('../../package');
    expectLocale(t, 'en');
  });

  it('falls back to en for a locale containing path separators', async () => {
    const t = await loadTranslation('en/../../package');
    expectLocale(t, 'en');
  });
});

// Audit 16 #461: nothing pinned key parity across the six locale files --
// a locale edit dropping a key from one file (e.g. the 0.5.22
// RATE_SECTION_EXHAUSTED_CARDS_FILTERED addition) failed nothing and
// surfaced as a raw key name in that language's UI.
describe('locale key parity (audit 16 #461)', () => {
  it('all six locale files share an identical key set', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), 'configs', 'localization');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    expect(files).toEqual(['de.json', 'en.json', 'es.json', 'fr.json', 'nl.json', 'pl.json']);

    const keysByFile = new Map<string, string[]>();
    for (const file of files) {
      const parsed = JSON.parse(await readFile(join(dir, file), 'utf-8'));
      keysByFile.set(file, Object.keys(parsed).sort());
    }
    const reference = keysByFile.get('en.json');
    for (const [file, keys] of keysByFile) {
      expect(keys, `${file} key set differs from en.json`).toEqual(reference);
    }
  });
});
