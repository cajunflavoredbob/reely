import { describe, it, expect, vi } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import { filterToQueryString } from '../../internal/app/plex/util';
import { filtersToPlexQueryString } from '../../internal/app/reely/providers/plex';

describe('filterToQueryString', () => {
  // Plex operators always end in '='. The slice(0, -1) trims the trailing '='
  // and the resulting key+suffix is the Plex query-string key. Each value
  // is emitted as a separate (key, value) tuple so commas inside a value
  // can't split into extra values on the Plex side (audit 9 #129).

  it('strips the trailing = from equality', () => {
    expect(
      filterToQueryString({ key: 'genre', operator: '=', value: ['Action'] }),
    ).toEqual([['genre', 'Action']]);
  });

  it('preserves != as ! on the key', () => {
    expect(
      filterToQueryString({ key: 'genre', operator: '!=', value: ['Action'] }),
    ).toEqual([['genre!', 'Action']]);
  });

  it('preserves >= as > on the key', () => {
    expect(
      filterToQueryString({ key: 'year', operator: '>=', value: ['2000'] }),
    ).toEqual([['year>', '2000']]);
  });

  it('preserves <= as < on the key', () => {
    expect(
      filterToQueryString({ key: 'year', operator: '<=', value: ['2020'] }),
    ).toEqual([['year<', '2020']]);
  });

  it('preserves ~= as ~ on the key', () => {
    expect(
      filterToQueryString({ key: 'title', operator: '~=', value: ['matrix'] }),
    ).toEqual([['title~', 'matrix']]);
  });

  it('preserves >>= as >> on the key', () => {
    expect(
      filterToQueryString({ key: 'year', operator: '>>=', value: ['2000'] }),
    ).toEqual([['year>>', '2000']]);
  });

  // Plex advertises the date "is before" operator as a bare '<<'; the
  // provider normalizes it to '<<=' before it reaches the client
  // (audit 16 #449), and this is the wire form it produces.
  it('preserves <<= as << on the key', () => {
    expect(
      filterToQueryString({ key: 'addedAt', operator: '<<=', value: ['2020-01-01'] }),
    ).toEqual([['addedAt<<', '2020-01-01']]);
  });

  it('emits one tuple per value (multi-value filters use repeated keys)', () => {
    expect(
      filterToQueryString({ key: 'genre', operator: '=', value: ['Action', 'Drama'] }),
    ).toEqual([['genre', 'Action'], ['genre', 'Drama']]);
  });

  it('keeps a value containing a comma whole (no Plex-side split)', () => {
    expect(
      filterToQueryString({ key: 'label', operator: '=', value: ['a,b', 'c'] }),
    ).toEqual([['label', 'a,b'], ['label', 'c']]);
  });
});

describe('filtersToPlexQueryString', () => {
  // Helper -- URLSearchParams stringifies stably so equality on .toString()
  // is the clearest way to assert the result.
  const params = (q: URLSearchParams) => q.toString();

  it('returns an empty URLSearchParams when filters is undefined', () => {
    expect(params(filtersToPlexQueryString(undefined))).toBe('');
  });

  it('returns an empty URLSearchParams when filters is empty', () => {
    expect(params(filtersToPlexQueryString([]))).toBe('');
  });

  it('converts filters to query-string params', () => {
    expect(params(filtersToPlexQueryString([
      { key: 'genre', operator: '=', value: ['Action'] },
      { key: 'year', operator: '>=', value: ['2000'] },
    ]))).toBe('genre=Action&year%3E=2000');
  });

  it('uses repeated keys for multi-value filters (no comma join)', () => {
    expect(params(filtersToPlexQueryString([
      { key: 'genre', operator: '=', value: ['Action', 'Drama'] },
    ]))).toBe('genre=Action&genre=Drama');
  });

  // The 'library' filter is handled specially in getMedia (used to pick which
  // Plex libraries to search) and must not appear as a Plex API filter param.
  it("skips the 'library' filter", () => {
    expect(params(filtersToPlexQueryString([
      { key: 'library', operator: '=', value: ['1'] },
      { key: 'genre', operator: '=', value: ['Action'] },
    ]))).toBe('genre=Action');
  });
});
