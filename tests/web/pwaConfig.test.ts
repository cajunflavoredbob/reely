import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Drift gate for the generateSW options in web/app/vite.config.ts. Both
// invariants below are silent when broken: the service worker still builds
// and still installs, it just stops doing the runtime caching the config
// says it does, and nothing surfaces that but a devtools console on a
// secure-context deploy. Asserted against the config source rather than a
// built sw.js so the gate runs without a Vite build.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = readFileSync(join(ROOT, 'web/app/vite.config.ts'), 'utf8');

describe('PWA service worker config', () => {
  it('keeps html out of the precache', () => {
    // The server substitutes index.html's placeholders per request, so a
    // precached copy would serve unresolved ones. This is also what makes
    // the navigateFallback override below necessary.
    const globPatterns = CONFIG.match(/globPatterns:\s*\[([^\]]*)\]/)?.[1];
    expect(globPatterns).toBeTruthy();
    expect(globPatterns).not.toMatch(/\bhtml\b/);
  });

  it('disables navigateFallback', () => {
    // generateSW defaults it to 'index.html' and emits
    // createHandlerBoundToURL('index.html'), which throws non-precached-url
    // while sw.js is still evaluating because index.html is not in the
    // precache. That throw aborts the module body, so every registerRoute
    // call after it is dead and no runtime caching is ever installed.
    expect(CONFIG).toMatch(/navigateFallback:\s*null/);
  });

  it('registers the poster route ahead of the broader /api/ route', () => {
    // Poster URLs are /api/poster/:providerIndex/:metadataId/:thumbId, so
    // the NetworkOnly /api/ rule also matches them. Workbox dispatches to
    // the first route registered that matches, so registering /api/ first
    // makes the poster cache unreachable without changing either pattern.
    const poster = CONFIG.indexOf("pathname.includes('/poster/')");
    const api = CONFIG.indexOf("pathname.startsWith('/api/')");
    expect(poster).toBeGreaterThan(-1);
    expect(api).toBeGreaterThan(-1);
    expect(poster).toBeLessThan(api);
  });
});
