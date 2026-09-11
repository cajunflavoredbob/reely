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

## [1.1.9] - 2026-09-11

No configuration changes, no wire-protocol changes, and nothing breaking for
image pinners: every item below is a repair to existing behavior or a
hardening of an existing surface.

### Fixed

- The room-file sweep no longer deletes rooms it merely failed to read. It
  used to wrap the read and the JSON parse in one catch whose handler
  unlinked the file, so a permission or I/O error (a volume whose files
  changed ownership after a PUID/PGID switch, say) answered a transient
  problem by destroying the data. Only a genuine parse failure removes a
  file now; anything else is logged with its path and left alone. A save
  interrupted between its temp write and the rename no longer strands the
  temp file either: the write path cleans up after itself, and the sweep
  reaps stale ones.
- A room save now snapshots its state when it is called rather than after
  the directory check, so a rating landing in that window can no longer be
  captured by an older save and committed out of order.
- Shutdown terminates WebSocket clients before draining the save queue
  instead of after. Ratings accepted during the drain used to arm a timer
  on a queue that had already been snapshotted and cleared, so the last
  swipes before a restart were the ones most likely to be lost.
- A WebSocket frame that is valid JSON but not an object (the four bytes
  `null`, for instance) is rejected instead of throwing inside a handler
  nobody was awaiting. Filter keys and filter arrays are now length-bounded
  before they reach Plex, and untrusted frames are truncated before they
  reach the log rather than being written out whole.
- A backward wall-clock step (an NTP correction, a host resumed from
  suspend) no longer silences a connection for the length of the jump: the
  per-connection message window rolls instead of waiting out a future
  timestamp.
- A failure reading `VERSION` during boot now logs fatal and exits 1. It
  previously fell through to the log-only unhandled-rejection handler and
  the process exited 0 without ever listening, which every supervisor reads
  as a clean shutdown rather than a crash loop.
- An unreachable Plex server at startup reports itself as unavailable with
  the underlying cause attached, instead of falling into the generic
  startup-error path. The message no longer truncates the server URL, which
  had been defeating the log redaction that matches the URL exactly.
- Credentials embedded in a Plex URL are stripped before that URL is sent
  to the browser.
- `NODE_ENV=development` no longer throws on the published image: the
  pretty-printing log transport is a dev dependency that is absent there,
  and its construction now falls back to plain NDJSON.
- The join button no longer sticks on "joining..." when the socket drops
  mid-request. The screen recovers on its own, and a reply that arrives
  after its own timeout puts you in the room rather than being discarded
  while you sit on the login form.
- The "not configured yet" screen now leaves once the server is configured,
  instead of stranding a returning visitor on a notice that promises it
  will.
- A filter whose values fail to load shows the failure and a Retry, rather
  than spinning on "Loading values..." forever. The failure is reported
  once per filter instead of once per filter per time the panel is opened.
- Holding an arrow key no longer rates a card per key-repeat, silently
  draining the deck past the server's rate limit and stopping matches with
  no visible sign.
- Like and Pass are disabled while disconnected instead of looking live and
  doing nothing, and toasts render above the mobile overlays instead of
  underneath them. The toast strip no longer swallows taps along the bottom
  of the screen.
- Poster images fall back to the placeholder when a request fails, instead
  of rendering the browser's broken-image glyph across the card.
- One Escape press closes only the topmost overlay, rather than dismissing
  the match celebration and the open filter panel together.
- Counts read "1 match" rather than "1 matches", the filter control is
  labelled the same on mobile and desktop, and a long room name truncates
  instead of pushing the desktop header's controls out of the viewport.
- A `config.yaml` that is empty, whitespace-only, or nothing but comments is
  treated as carrying no settings rather than killing the boot. Mounting a
  placeholder config while configuring through environment variables is a
  supported setup, and a configuration load failure is fatal, so this was
  worth getting right: js-yaml 5 raises on an empty document where 4 returned
  undefined, and the check now happens before the parse instead of depending
  on what the parser returns.

### Security

- `allowedOrigins` is validated when it comes from YAML, where a scalar
  used to be accepted silently and then reject every WebSocket upgrade.
  Paired settings are checked together, so a present-but-empty `TLS_KEY`
  alongside a `TLS_CERT` fails the boot instead of quietly serving plain
  HTTP.
- GitHub Actions are pinned to commit SHAs rather than mutable tags, and
  the runtime image's package upgrade is keyed on a build date so the layer
  cache stops serving an indefinitely stale one.

### Changed

- Dependencies: js-yaml 4.1.1 to 5.4.1, the runtime base image from
  node 26.7.0-slim to 26.8.1-slim, vite 6.4.2 to 8.2.2 for the UI build, and
  the test and build toolchains moved off packages carrying published
  advisories. The advisories were all in build- and test-time packages, which
  the runtime image does not contain.
- Documentation corrections: the Apache reverse-proxy example sets
  `ProxyPreserveHost On`, without which the WebSocket origin check rejects
  every upgrade; the HAProxy example includes the server name its syntax
  requires; the configuration guide no longer claims support for multiple
  Plex servers, which the code has always refused.

## [1.1.8] - 2026-08-21

### Changed

- Fonts (Geist, Geist Mono, Instrument Serif) are now bundled with the app
  as subset woff2 files (latin + latin-ext, ~364 KB) instead of loaded from
  Google Fonts. First load no longer makes any external request, which makes
  the README's "no external services" claim true as written; previously only
  repeat loads were offline-capable via the service worker cache. The CSP no
  longer whitelists the Google Fonts origins. Font licenses ship alongside
  the files (SIL OFL 1.1).

### Fixed

- LICENSE now contains the full Apache 2.0 text instead of only the header
  boilerplate, so GitHub detects the license correctly ("Apache-2.0" instead
  of "Other"). Upstream attribution moved to a new NOTICE file, per Apache-2.0
  section 4. The stated terms are unchanged.

## [1.1.7] - 2026-08-21

### Changed

- pino 9.14.0 to 10.3.1. reely's use of it is small (construct with a
  level and an optional pretty transport, mutate the level at runtime,
  log five severities), and all of it was exercised against the new
  major before merging, including the pino-pretty transport that only
  runs outside production and so is never covered by CI.
- Dev tooling: biome 2.5.9, vitest and coverage-v8 4.1.11.

## [1.1.6] - 2026-08-21

### Changed

- Comments across the codebase are roughly half their previous volume.
  A comment now says what a thing does when that is not obvious, or why
  it does it that way when that is not obvious, and nothing else. The
  audit and issue references that trailed most of them are gone,
  including from test names, along with the version-by-version
  narration of how each guard came to exist.
- The two Plex rating-bucket labels and one mobile aria-label used
  typographic dashes; they are plain ASCII now. The aria-label reads
  "N matches, tap to view" rather than using a dash, which is clearer
  read aloud.

### Fixed

- Four component tests rendered their subject, discarded the result,
  then rendered it again. Two of them were only correct because a
  container-scoped query happened to miss the duplicate DOM the first
  render left mounted.

### Removed

- `leaveRoomCleanup`'s `evicted` flag, added in 1.1.5 and left without
  a reader when the rename path it served stopped needing a save. Back
  to returning the prior room.

## [1.1.5] - 2026-08-21

### Security

- Filter browsing now requires a logged-in session. `requestFilters` and
  `requestFilterValues` were the only provider-touching handlers with
  no login gate, so anyone who completed the WebSocket upgrade could
  read the library's full filter schema and drive Plex queries without
  identifying themselves. On a deployment without `basicAuth` (the
  default) that was reachable from the network.
- Filters on a `createRoom` / `joinRoom` request are validated like
  filters on `applyFilters`, and so are filters restored from a room
  file. Both fed the Plex query layer unchecked, bypassing every length
  and shape cap, and the persisted copy replayed on every restart.
- Per-source connection accounting groups IPv6 addresses by /64 instead
  of keying on the raw address. A single host is routinely handed a /64
  and can source from any address in it, so the 20-socket-per-IP cap
  bounded nothing; worse, filling the tracking map turned its own size
  cap into a lockout for every address not already in it. The HTTP rate
  limiter and the Basic Auth failure throttle use the same key, which
  the throttle's shared budget depends on.

### Fixed

- The WebSocket handlers that carry identity or room membership across
  an await no longer run concurrently on one connection: login, logout,
  create, join, leave and applyFilters. `ws.on('message')` fires per
  frame and the handlers are async, so a single TCP read carrying
  several frames started several overlapping chains. Those handlers
  capture state before multi-second awaits (a Plex fetch, a disk load,
  the liveness probe) and commit it after, so an interleaved frame
  could change the world underneath them: members keyed by a stale
  username that no cleanup path could remove, filters applied to
  whichever room the client had since joined, a joiner attached to a
  room the TTL sweep had collected. Arrival-time checks stay
  synchronous so the rate limiter still bounds arrivals, and socket
  close is ordered too, so cleanup runs after an in-flight join rather
  than racing it. `rate`, `setLocale` and the two filter-browsing
  handlers deliberately stay concurrent: they hold no state across an
  await, and serialising them would have made the filter panel's
  parallel value fetches queue up past the client's own timeout and let
  swipes be dropped behind a slow filter change.
- A client that disconnects mid-create or mid-join is no longer added
  to the room. The commit ran unconditionally after the await, creating
  a member nothing could ever remove: close is once-only and had
  already fired, cleanup only runs from inbound messages a dead socket
  cannot send, and the ping sweep no longer holds the socket. The room
  never returned to zero users, so it and its file leaked until
  restart.
- Rooms that are actively being swiped now persist. The save debounce
  was trailing-edge only, so every rating cleared and re-armed the
  timer and a room with swipes closer together than the window never
  saved at all -- the exact inverse of the guarantee it documented. An
  idle room persisted; a busy one lost its whole session on a crash.
- The TTL sweep's disk pass re-checks that a room is still absent from
  memory after reading its file, the guard the in-memory pass already
  had. A join landing during that read left the sweep holding a stale
  buffer and deleting a file written moments earlier for a room people
  were actively using.
- A match stays visible after a filter excludes its title.
  `applyFilters` deliberately preserves ratings so an existing match
  survives, but `getMatches` resolved each one through the current
  media set and silently dropped the misses, so the match vanished from
  the UI on the next rejoin -- and rejoin fires on every network blip.
  The archive is in memory only, so a match whose title falls outside
  the room's filters does still drop after a server restart.
- `match` events go only to the users who liked the title, matching
  what the rejoin snapshot returns. A member who disliked it, or never
  rated it, used to get the celebration and then lose the entry with no
  explanation on their next refresh.
- Restored rooms validate `userProgress` per entry, like `ratings`
  already did. A non-numeric count turned progress into string
  concatenation that compounded on disk, and a null one reached the
  frontend as `progress: null`.
- Renaming while in a room no longer leaves that room's state
  inconsistent, and no longer acts on behalf of a connection that a
  newer one has already replaced.
- A queued `applyFilters` can no longer fire into a different room
  minutes later, and neither it nor `setLocale` waits forever on a
  socket that never returns.
- Rates replayed after a reconnect re-record their dedup ids, so the
  cards the server hands back in its pre-flush deck cannot be swiped a
  second time into a vote that counts as neither progress nor rating.
- favicon.ico is rebuilt correctly. The 1.1.4 file was 8-bit paletted
  with a 1-bit transparency mask, which banded the gradient and left
  the 32x32 and 48x48 frames flooded with an opaque brown backdrop --
  so the tab icon was a muddy square on HiDPI displays and the correct
  transparent mark on 1x. All three frames are now PNG-compressed at
  full 32-bit alpha. The 1.1.4 entry below claims this file gained its
  16/32/48 sizes in that release; it already had them, at a higher bit
  depth. The entry is left as published and corrected here.
- The mark is centred in its canvas. The 1.1.4 artwork left a 3px
  margin on one side against 106px on the other, which every icon size
  inherited and which was plainly visible on the iOS home screen.
- The in-app Logo gradient matches the shipped brand assets. It was
  declared with `gradientUnits="userSpaceOnUse"` where the SVG assets
  use the `objectBoundingBox` default. Same endpoints, different
  result: the bounding-box form shears the gradient axis by the card's
  aspect ratio, so the header mark and the favicon beside it ran their
  gradients about 19 degrees apart.
- Server builds no longer carry source comments into the published
  Docker image (`removeComments`), so `dist/` is code rather than
  code plus every post-mortem note written beside it.

### Added

- `pnpm gen:brand` regenerates every derived brand asset from
  `docs/branding/reely-logo.svg`: the icon set, favicon.ico, the PNG
  exports, and the geometry module the Logo component draws from. The
  mark was previously hand-copied into four files, produced by a
  toolchain recorded nowhere, which is how the icon defects above
  shipped unnoticed.
- Tests that assert the artwork itself. The Logo suite checked
  dimensions and ids but nothing about the drawing, so the entire mark
  could be (and was) replaced with the suite green. It now pins the
  geometry, the gradient units, and that the top card points at a
  paint server that exists; `tests/web/brandAssets.test.ts` fails if
  the checked-in SVGs drift from the master.

### Changed

- `package.json` now declares `Apache-2.0`, matching `LICENSE` and the
  README. It said `MIT`, which contradicted both: the code is a
  continuation of the Apache-2.0 licensed MovieMatch. Nothing about the
  actual licensing changes, but the field registries and tooling read
  was wrong.
- The SVG mark's `<title>` is lowercase `reely`, matching the HTML
  title, the manifest name and the README. It read `Reely`, and since
  the Unraid container template points straight at `icon.svg`, that is
  the string assistive tech speaks as the app's name.
- `pnpm gen:brand` also stamps the PWA manifest's icon URLs with a
  digest of the icon bytes, so an already-installed app picks up new
  artwork instead of keeping the icon it was installed with. iOS still
  needs a remove and re-add.
- docs/branding/README.md documents the generator, the centring
  transform, and why the three brand gradients differ. It previously
  described the icon set as "a separate set" that "stays as-is",
  which stopped being true when three of those files became generated
  copies.

## [1.1.4] - 2026-08-16

### Changed

- In-app brand brought in line with the 1.1.3 refresh: the Logo
  component draws the fanned card mark with the "r" as an outlined
  path (pixel-matches docs/branding, no serif-fallback flash before
  the webfont loads), and every static icon is regenerated from the
  new mark: SVG favicon, favicon.ico (now proper 16/32/48 multi-size),
  PWA icon-192/512, icon-32, and the apple-touch icon-180 (app-chrome
  background baked in, since iOS renders transparency as black).

## [1.1.3] - 2026-08-16

### Changed

- README rebuilt around the new brand: header lockup, feature summary,
  desktop and mobile screenshots, compose-first run instructions, and
  an identity-model note; configuration reference and FAQ carried over.
- Brand refresh: the dark-plate logo is replaced by a transparent
  fanned-card mark that works on light and dark surfaces, with an
  outlined Instrument Serif wordmark lockup for the README header.
  Docker Hub and Unraid exports regenerated; the separate light
  variant is gone (no longer needed).

### Added

- docs/screenshots/: desktop and mobile app captures used by the
  README.

## [1.1.2] - 2026-08-16

### Changed

- The 1.0.0 changelog entry is now simply the initial-release marker;
  per-change detail starts with the versions that follow it.
- docker-compose.yml example pin raised to the current image tag.

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
