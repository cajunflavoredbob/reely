import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { posterSrc } from '../../web/app/src/utils/poster';

// posterSrc reads `document.body.dataset.rootPath` at CALL time (not
// module-import time), so a single beforeEach stub is enough -- no
// vi.resetModules dance needed.

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

  // The dataset object exists but `.rootPath` is undefined on a fresh page
  // without a reverse-proxy mount. The `?? ""` fallback must coalesce that
  // to an empty prefix, not the literal string "undefined".
  it('coalesces a missing dataset.rootPath to an empty prefix', () => {
    setupRootPath(undefined);
    expect(posterSrc('/api/poster/0/12345/thumb')).toBe('/api/poster/0/12345/thumb');
  });
});
