import type { Filter } from '../../../types/reely';
import { logger } from '../reely/logger';

// Fan-out helper for the per-library Promise.allSettled pattern used by
// PlexApi.getAllFilters, PlexApi.getFilterValues, and the provider's
// getMediaCached (audit 13 #326). Each was a hand-rolled
// `Promise.allSettled(libraries.map(...))` followed by an
// outcome-iterator that logged rejections and pushed fulfilled into
// an accumulator. The three sites had identical fan-out logic with
// different downstream accumulation; centralizing the fan-out lets
// each caller focus on its own merge.
//
// Tolerates per-library failures: one unreachable or malformed
// section never sinks the whole result. Logs at warn level with the
// caller-provided `logPrefix` so a future operator can grep for
// which fan-out had which failure.
// Generic over the library shape: PlexApi callers pass PlexLibrary[]
// (raw API response shape); the provider's getMediaCached passes
// Library[] (app-layer normalized shape). The helper only iterates;
// the per-call fn is what reads library fields.
export const fanOutLibraries = async <L, T>(
  libraries: L[],
  logPrefix: string,
  fn: (lib: L) => Promise<T>,
): Promise<T[]> => {
  const settled = await Promise.allSettled(libraries.map(fn));
  const fulfilled: T[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      fulfilled.push(outcome.value);
    } else {
      logger.warn(
        `${logPrefix}: skipping a library section that failed: ${String(outcome.reason)}`,
      );
    }
  }
  return fulfilled;
};

// Plex operator suffixes always include a trailing '='. The query-string form
// of the filter key drops that '=' (URLSearchParams re-adds it as the
// key/value separator):
//   '='   -> ''   -> `key=value`     (equality)
//   '!='  -> '!'  -> `key!=value`    (inequality)
//   '>='  -> '>'  -> `key>=value`    (gte)
//   '>>=' -> '>>' -> `key>>=value`   (Plex-specific)
//
// Returns one (key, value) entry per filter value, not a comma-joined string.
// Plex's filter API treats `,` inside a value as a multi-value separator,
// so joining `['a,b', 'c']` as `'a,b,c'` would split into three values on
// the Plex side. Emitting each value as a repeated query-string key is the
// correct multi-value form -- and URLSearchParams.append will URL-encode
// each one independently, so values containing `&`, `=`, etc. survive.
export const filterToQueryString = (
  { key, value, operator }: Filter,
): Array<[key: string, value: string]> => {
  const queryKey = key + operator.slice(0, -1);
  return value.map((v) => [queryKey, v] as [string, string]);
};
