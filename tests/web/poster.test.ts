import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { posterSrc } from '../../web/app/src/utils/poster';

// posterSrc reads document.body.dataset.rootPath at call time, so a single
// beforeEach stub is enough; no vi.resetModules needed.

const setupRootPath = (rootPath: string | undefined) => {
  const dataset = rootPath === undefined ? {} : { rootPath };
  vi.stubGlobal('document', { body: { dataset } });
};

beforeEach(() => {
  setupRootPath('');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('posterSrc', () => {
  it('returns undefined when no posterUrl is given', () => {
    expect(posterSrc(undefined)).toBeUndefined();
  });

  it('returns the bare URL when no rootPath is configured', () => {
    expect(posterSrc('/api/poster/0/12345/thumb')).toBe('/api/poster/0/12345/thumb');
  });

  it('prefixes the rootPath when one is configured', () => {
    setupRootPath('/reely');
    expect(posterSrc('/api/poster/0/12345/thumb')).toBe('/reely/api/poster/0/12345/thumb');
  });

  // Without a reverse-proxy mount the dataset exists but rootPath does not;
  // the `?? ""` must not leave the literal string "undefined" in the path.
  it('coalesces a missing dataset.rootPath to an empty prefix', () => {
    setupRootPath(undefined);
    expect(posterSrc('/api/poster/0/12345/thumb')).toBe('/api/poster/0/12345/thumb');
  });
});
