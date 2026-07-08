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
    // Default environment is 'node' (server-side tests + the existing web
    // tests that exercise pure logic with stubbed DOM globals). React
    // component tests under tests/web/components/ opt into jsdom per file
    // via the `// @vitest-environment jsdom` directive at the top of the
    // file (audit 13 #338 web-layer setup, 0.4.34). Per-file override
    // keeps the rest of the suite on the faster node env.
    environment: 'node',
    // `.tsx` added 0.4.34 so React component tests under tests/web/components/
    // are picked up alongside the existing `.test.ts` files.
    include: ['tests/**/*.test.{ts,tsx}'],
    // Behavior knobs (audit 12 #251):
    //   clearMocks   -- before each test, clear all spy/mock call history.
    //                   Stops one test's calls from showing up in another's
    //                   `expect(fn).toHaveBeenCalledWith(...)` assertions.
    //   restoreMocks -- before each test, restore any spied-on implementations
    //                   to their originals. Catches a test that monkey-patched
    //                   a module-level export and forgot to undo it.
    //   testTimeout  -- per-test deadline. Our suite is all sub-second; any
    //                   test that takes >5s is hung (e.g. an unhandled await
    //                   on a never-resolving promise) and should fail loud.
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 5000,
    // Coverage configuration (audit 13 #346). `v8` provider is the
    // built-in fast option; `text` is what the operator sees, `lcov`
    // feeds GitHub Actions / Codecov integrations if those land
    // later. Run with `pnpm test --coverage`. No thresholds set yet
    // because the existing surface is partial (per audit 13 #338);
    // adding thresholds without first scoping the uplift would
    // either fail CI immediately or pretend the gaps don't exist.
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
