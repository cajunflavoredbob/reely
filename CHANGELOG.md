# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

Reely is a community continuation of [MovieMatch](https://github.com/LukeChannings/moviematch)
by Luke Channings, picking up from MovieMatch 2.0.0-beta.4, the last upstream release
before the project was abandoned in 2021. The upstream release history is preserved in
[RELEASE_NOTES.markdown](./RELEASE_NOTES.markdown). This changelog starts at 1.0.0,
the continuation's first stable release.

---

## [Unreleased]

## [1.1.2] - 2026-08-16

### Changed

- The 1.0.0 changelog entry is now simply the initial-release marker;
  per-change detail starts with the versions that follow it.

## [1.1.1] - 2026-08-16

### Removed

- Pre-1.0 development history: the 0.x changelog entries and the separate
  archive file are gone; this changelog now starts at 1.0.0.
- CONTRIBUTING note about pending filter-panel i18n coverage.

### Changed

- Wording and punctuation cleanups in README and CONTRIBUTING.

## [1.1.0] - 2026-08-16

Dependency refresh.

### Changed

- **Node 26**: Docker base images to `node:26.7.0-slim`, CI floors and
  `engines.node` to 26 in lockstep. Node 25+ images no longer ship
  corepack, so the builder now installs pnpm via `npm install -g
  pnpm@10.33.2` (same pin as `packageManager`). Running from source now
  requires Node >= 26; the published image is unaffected by that floor.
- **express 5.2.1** (from 4.21.2): catch-all route respelled
  `'/{*splat}'` for path-to-regexp v8; poster handler params typed via
  the `Request` generic (express 5 types params `string | string[]`).
- **react 19.2** (from 18.3) with `@types/react(-dom)` 19:
  `@react-spring/web` to 10.1.2 (v9 types are react-19-incompatible),
  the JSX type now imported from `react`, and an obsolete `as any` cast
  on the spring record in CardStack removed (v10 types expose
  `SpringValue.get()` directly).
- **@types/node 26**, matching the shipped runtime.
- Runtime group: helmet 8.3.0, ws 8.21.1, zustand 5.0.14. Dev group:
  biome 2.5.2 (config migrated: `rules.preset`), tsx 4.23.0, vitest
  4.1.10. Actions: checkout v7, setup-node v7, pnpm/action-setup 6.0.9.
- vitest workers run with `--no-experimental-webstorage`: node 26's
  built-in Web Storage global shadowed jsdom's localStorage and broke
  22 jsdom-env tests; the legacy flag spelling is accepted by node 24
  and 26 alike.

### Fixed

- Terminal express error handler: rejected async handler promises (a
  new express 5 path) now log through the redacting pino logger and
  answer a bare 500; previously the stack was printed to stderr and
  echoed into the 500 body when NODE_ENV was unset.
- CI: `persist-credentials: false` on all checkout steps (no workflow
  performs git writes).
- `pnpm test --coverage` works: the configured `@vitest/coverage-v8`
  provider is now an installed devDependency, with `coverage/`
  gitignored.
- Stale docs and comments: CONTRIBUTING prerequisite raised to Node 26,
  Dockerfile corepack-era comment drift reworded.
- icon.svg carries a `<title>` element for SVG accessibility.

## [1.0.0] - 2026-07-07

Initial release.
