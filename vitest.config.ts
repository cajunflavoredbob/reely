import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

// pnpm workspaces keep React + Zustand isolated under
// web/app/node_modules. Test files at tests/web/ run from the repo
// root, where those deps aren't visible. Two pieces are needed:
//   1. @vitejs/plugin-react -- transforms JSX with the automatic
//      runtime (same as web/app's prod build).
//   2. resolve.alias for `react` + `react-dom` + the JSX runtimes +
//      `zustand` + `zustand/react/shallow`, pointing at web/app's
//      installs. Otherwise Vite emits imports like `react/jsx-dev-
//      runtime` that can't resolve from the root, and importing
//      React from two places would land on "Invalid hook call" --
//      two React instances can't share hook state. The alias
//      funnels everything to the one copy in web/app. Zustand was
//      added 0.4.41 when useSelector got its first test (the hook
//      imports from `zustand/react/shallow`).
const webAppDep = (path: string) =>
  fileURLToPath(new URL(`./web/app/node_modules/${path}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'react/jsx-dev-runtime': webAppDep('react/jsx-dev-runtime.js'),
      'react/jsx-runtime': webAppDep('react/jsx-runtime.js'),
      'react-dom/client': webAppDep('react-dom/client.js'),
      'react-dom': webAppDep('react-dom/index.js'),
      react: webAppDep('react/index.js'),
      'zustand/react/shallow': webAppDep('zustand/react/shallow.js'),
      'zustand/react': webAppDep('zustand/react.js'),
      zustand: webAppDep('zustand/index.js'),
    },
  },
  test: {
    // React component tests opt into jsdom per file with a
    // `// @vitest-environment jsdom` directive; the rest stay on faster node.
    environment: 'node',
    // Node 26's built-in localStorage shadows the one jsdom would install, so
    // every jsdom test touching it breaks. This spelling is the only one both
    // node 24 and 26 accept.
    execArgv: ['--no-experimental-webstorage'],
    // `.tsx` so React component tests are picked up alongside `.test.ts`.
    include: ['tests/**/*.test.{ts,tsx}'],
    // clearMocks: one test's calls must not show up in another's assertions.
    // restoreMocks: catches a test that monkey-patched an export and forgot.
    // testTimeout: the suite is sub-second, so 5s means hung, not slow.
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 5000,
    // `pnpm test --coverage`. No thresholds: the covered surface is partial,
    // so a threshold would either fail CI at once or be set low enough to lie.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['cmd/**/*.ts', 'internal/**/*.ts', 'web/app/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.d.ts',
        'tests/**',
        'dist/**',
        '**/node_modules/**',
        'web/app/dist/**',
      ],
    },
  },
});
