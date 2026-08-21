import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

// Runs against the real configs/localization/ files: getTranslations calls
// getAvailableLocales and loadTranslation through closure, which vi.mock
// cannot re-route.
import { getTranslations, loadTranslation } from '../../internal/app/reely/i18n';

// Named apart from helpers.ts's `makeReq`, which stubs socket.remoteAddress
// instead and would yield a request with no Accept-Language header.
const makeAcceptLanguageReq = (acceptLanguage?: string): Request =>
  ({
    headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {},
  } as unknown as Request);

// FILTERS_LOADING differs per locale, so it identifies the file negotiation
// picked.
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
    // German has the highest q, though English appears first.
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
  // `setLocale` is an unauthenticated WS message and its language string
  // reaches loadTranslation directly, so an unguarded join() would read any
  // .json on disk, data/rooms/*.json included.
  it('falls back to en for a `../`-traversal locale', async () => {
    // Unguarded this resolves to <cwd>/package.json, which parses but has no
    // FILTERS_LOADING key.
    const t = await loadTranslation('../../package');
    expectLocale(t, 'en');
  });

  it('falls back to en for a locale containing path separators', async () => {
    const t = await loadTranslation('en/../../package');
    expectLocale(t, 'en');
  });
});

// A locale edit that drops a key from one file fails nothing else, and
// surfaces as a raw key name in that language's UI.
describe('locale key parity', () => {
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
