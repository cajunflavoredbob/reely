# Contributing

## Prerequisites

- [Node.js](https://nodejs.org/) v26 or later
- [pnpm](https://pnpm.io/) v10 (`npm install -g pnpm`)
- A Plex server with a valid token (for end-to-end testing)

## Getting started

```
git clone https://github.com/your-fork/reely
cd reely
pnpm install
pnpm build
```

Run the server:

```
PLEX_URL=http://your-plex:32400 \
PLEX_TOKEN=your-token \
node dist/cmd/reely/main.js
```

For frontend development with hot reload, run the server in one terminal and Vite in another:

```
# Terminal 1 — backend
pnpm build:server
PLEX_URL=... PLEX_TOKEN=... node dist/cmd/reely/main.js

# Terminal 2 — frontend dev server (proxies /api to port 8000)
cd web/app && pnpm dev
```

Open [http://localhost:5173](http://localhost:5173).

## Project layout

Following [Golang's project layout](https://github.com/golang-standards/project-layout) convention.

```
.
├── cmd/reely/        # Server entry point
├── configs/localization/  # Translation JSON files (BCP47 filenames)
├── dist/                  # Build output (gitignored)
│   └── web/               # Bundled frontend served by the server
├── docs/                  # Supplemental documentation
├── internal/app/
│   ├── reely/             # Core server logic (rooms, clients, config, i18n)
│   └── plex/              # Plex API client
├── types/                 # Shared TypeScript types (server + frontend)
│   └── reely.ts           # WebSocket protocol types, shared interfaces
├── web/app/               # Frontend (React 18, Vite, Zustand)
│   └── src/
│       ├── api/           # WebSocket client wrapper
│       ├── components/    # React components (atoms → molecules → organisms → screens)
│       ├── store/         # Zustand store, reducer, types
│       └── types.ts       # Frontend-only types
├── CHANGELOG.md           # This project's changelog (0.y.z series)
├── RELEASE_NOTES.markdown # Upstream release history (preserved, do not edit)
├── VERSION                # Current version string
└── docker-compose.yml     # Reference deployment with Docker secrets
```

## Build commands

| Command | Description |
|---|---|
| `pnpm build` | Full build (server + frontend) |
| `pnpm build:server` | Server only (runs `tsc`) |
| `pnpm build:ui` | Frontend only (runs Vite) |

## Shared types

The WebSocket protocol is defined in `types/reely.ts`. Both the server and frontend import from this file. If you add a new message type, update both `ServerMessage` (client→server) and `ClientMessage` (server→client) as needed.

## i18n

Translation files live in `configs/localization/` and follow [BCP47](https://tools.ietf.org/html/bcp47) naming (`en.json`, `de.json`, etc.). The `TranslationKey` type in `types/reely.ts` defines all required keys.

All keys are present in all six locales (en, es, fr, pl, de, nl). Native speaker review of the German and Dutch translations is welcome -- they were machine-translated.

The filter panel UI (Filters button, proposal banner, active filter chips) currently uses hardcoded English strings. Adding i18n coverage for these is tracked as a future task.

## CI

GitHub Actions runs on every push (`ci.yml`): typecheck + build + the full test suite, Biome lint (errors block, warnings surface), `pnpm audit` at warn level, a multi-arch Docker build, and a Trivy image scan at warn level. Tag pushes additionally run `release.yaml`, where a CRITICAL fixable CVE in the Trivy scan hard-blocks the publish. See `.github/workflows/`.

## Release process

A version bump touches **four files** -- `VERSION`, `package.json`, `CHANGELOG.md`, and the `docker-compose.yml` image pin. The release workflow verifies all of them against the tag and fails the publish on any mismatch.

1. Update `VERSION` to the release version (e.g. `1.0.0`).
2. Update `version` in `package.json` to match.
3. Update the image pin in `docker-compose.yml` to `cajunflavoredbob/reely:x.y.z`.
4. In `CHANGELOG.md`, rename `[Unreleased]` to `[x.y.z] - YYYY-MM-DD` and add a new empty `[Unreleased]` section above it.
5. Commit: `chore: release x.y.z`.
6. Tag: `git tag vx.y.z && git push origin vx.y.z`.
7. The GitHub Actions release workflow builds the Docker image and creates a GitHub release.
