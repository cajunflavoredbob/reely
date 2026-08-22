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
        runtimeCaching: [
          {
            // Never cache API or WebSocket upgrades. Match on pathname so the
            // test works against full URLs.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
          {
            // Posters: fresh art when online, cached copy when not.
            urlPattern: ({ url }) => url.pathname.includes('/poster/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'posters',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
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
  define: {
    'import.meta.env.VERSION': JSON.stringify(process.env.VERSION ?? 'dev'),
  },
})
