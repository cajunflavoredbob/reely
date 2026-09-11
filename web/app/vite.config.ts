import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Dev defaults for the server-side template placeholders, so the dev server
// works without a build first.
const injectDevVars = {
  name: 'inject-dev-vars',
  apply: 'serve' as const,
  transformIndexHtml(html: string) {
    // These are literal placeholder strings in index.html, not JS template
    // expressions; this is a string replace, not interpolation.
    return html
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template placeholder.
      .replace('${rootPath}', '')
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional template placeholder.
      .replace('${version}', process.env.VERSION ?? 'dev');
  },
};

export default defineConfig({
  base: './',
  plugins: [
    react(),
    injectDevVars,
    VitePWA({
      registerType: 'autoUpdate',
      // Use static/manifest.webmanifest; don't generate one.
      manifest: false,
      workbox: {
        // No html: the server substitutes index.html's placeholders per
        // request, so a cached raw build would serve unresolved ones and
        // break the WebSocket URL.
        globPatterns: ['**/*.{js,css,ico,png,svg,webmanifest,woff2}'],
        // generateSW otherwise defaults navigateFallback to 'index.html' and
        // emits createHandlerBoundToURL('index.html'), which throws
        // non-precached-url at module scope because globPatterns above keeps
        // html out of the precache. That throw aborted the rest of sw.js, so
        // neither runtimeCaching rule below ever registered.
        navigateFallback: null,
        runtimeCaching: [
          {
            // Posters: fresh art when online, cached copy when not. Must stay
            // ahead of the /api/ rule: poster URLs are /api/poster/..., and
            // Workbox takes the first route registered that matches.
            urlPattern: ({ url }) => url.pathname.includes('/poster/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'posters',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            // Never cache the rest of the API, or WebSocket upgrades. Match on
            // pathname so the test works against full URLs.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  publicDir: 'static',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
})
