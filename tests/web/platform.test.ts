import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `isIOS` is computed at module-import time from `navigator.userAgent`
// (a module-level const, not a function). Each test stubs navigator
// + calls vi.resetModules() so the re-import re-runs the IIFE-style
// regex test against the new userAgent.
const loadIsIOS = async () => {
  const mod = await import('../../web/app/src/utils/platform');
  return mod.isIOS;
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isIOS', () => {
  it('is true for iPhone userAgent strings', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    });
    expect(await loadIsIOS()).toBe(true);
  });

  it('is true for iPad userAgent strings', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    });
    expect(await loadIsIOS()).toBe(true);
  });

  it('is false for desktop userAgent strings', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0',
    });
    expect(await loadIsIOS()).toBe(false);
  });

  // Documented quirk: iPadOS 13+ reports as "MacIntel" / Mac userAgent so
  // this regex misses those devices. Pinning the behavior here so future
  // edits don't quietly "fix" it without a behavior decision.
  it('is false for the iPadOS 13+ Mac-disguised userAgent (known false negative)', async () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15',
    });
    expect(await loadIsIOS()).toBe(false);
  });
});
