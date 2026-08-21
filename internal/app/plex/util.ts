import type { Filter } from '../../../types/reely';
import { logger } from '../reely/logger';

// Parallel per-library fan-out that tolerates partial failure: one unreachable
// or malformed section never sinks the whole result. `logPrefix` names the
// caller so an operator can tell the fan-outs apart in the log.
//
// Generic over the library shape because PlexApi passes the raw PlexLibrary
// and the provider passes the normalized Library; only `fn` reads fields.
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

// Operators always end in '='; the query-string key drops it because
// URLSearchParams re-adds it as the separator:
//   '='   -> ''   -> `key=value`
//   '!='  -> '!'  -> `key!=value`
//   '>>=' -> '>>' -> `key>>=value`
//
// One entry per value, never comma-joined: Plex treats `,` inside a value as a
// multi-value separator, so `['a,b', 'c']` would arrive as three values.
// Repeated keys also let append() encode each value independently.
export const filterToQueryString = (
  { key, value, operator }: Filter,
): Array<[key: string, value: string]> => {
  const queryKey = key + operator.slice(0, -1);
  return value.map((v) => [queryKey, v] as [string, string]);
};
