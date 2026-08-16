# Changelog

All notable changes to this project are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

This is a community continuation of [MovieMatch](https://github.com/LukeChannings/moviematch)
by Luke Channings. Development picks up from MovieMatch 2.0.0-beta.4, the last upstream release
before the project was abandoned in 2021. The upstream release history is preserved in
[RELEASE_NOTES.markdown](./RELEASE_NOTES.markdown) for reference. This changelog covers all
changes made under the community continuation, versioned independently from 0.1.0 onward.

Per-release detail for completed y-versions (0.1.0 - 0.4.50) lives in
[docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md). The current y-version
(0.5.x) stays detailed below until the next minor cuts; on rollover its
detail moves to the archive in a CHANGELOG-only maintenance bump and a
single `[0.5.x]` summary block replaces it here.

---

## [Unreleased]

## [1.1.0] - 2026-08-16

Dependency refresh: the nine open dependabot PRs (#1, #4, #5, #6, #7,
#10, #11, #12, #14) resolved in one batch, each verified individually
(typecheck, full suite, build, lint, plus runtime smokes for the
majors), followed by a fan-out audit (audit 17) of the changed surface.

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
  JSX type now imported from `react`, and the v9-era `springs as any`
  cast in CardStack dropped (audit 14 #364's revisit-on-v10 note).
- **@types/node 26**, matching the shipped runtime.
- Runtime group: helmet 8.3.0, ws 8.21.1, zustand 5.0.14. Dev group:
  biome 2.5.2 (config migrated: `rules.preset`), tsx 4.23.0, vitest
  4.1.10. Actions: checkout v7, setup-node v7, pnpm/action-setup 6.0.9.
- vitest workers run with `--no-experimental-webstorage`: node 26's
  built-in Web Storage global shadowed jsdom's localStorage and broke
  22 jsdom-env tests; the legacy flag spelling is accepted by node 24
  and 26 alike.

### Fixed

- Audit 17 (post-refresh audit: zero HIGH findings; Low/Medium batch
  all fixed):
  - Terminal express error handler: rejected async handler promises
    (a new express 5 path) now log through the redacting pino logger
    and answer a bare 500; previously finalhandler printed the stack
    to stderr and echoed it into the body when NODE_ENV was unset.
  - CI: `persist-credentials: false` on all checkout steps (no
    workflow performs git writes).
  - `pnpm test --coverage` works again: the configured
    `@vitest/coverage-v8` provider was never installed (pre-existing);
    now a devDependency, with `coverage/` gitignored.
  - Stale docs/comments: CONTRIBUTING prerequisite to Node 26,
    Dockerfile corepack-era comment drift reworded.
  - icon.svg carries a `<title>` (biome 2.5's a11y rule).

## [1.0.0] - 2026-07-07

First stable release.

Reely is feature-complete: Plex-backed swipe-to-match across a shared
room, synthetic rating filters, and the correctness/hardening work
accumulated over sixteen internal audits. 1.0.0 promotes the 0.5.x line
to stable with no functional change from 0.5.23 beyond the audit-16
fixes below.

### Fixed

- Audit 16 -- 44 findings resolved (3 HIGH, 17 MEDIUM, 24 LOW) across the
  Plex provider, room/session handling, static-asset serving, and the
  web client. Hardening and correctness only; no user-facing feature
  change. Highlights: movie-library-only filter fan-out, rating buckets
  relabelled "9.0-10" with 10.0 clamped in, provider date-operator
  normalisation ('<<' -> '<<='), static-asset cache policy (1y-immutable
  for hashed assets, max-age=0 for sw.js/manifest), and a locale
  key-parity guard so a missed translation fails the test suite.

## [0.5.23] - 2026-05-30

### Fixed (filter pickers regression -- production bug)

Every filter row in the FilterPanel was rendering as a free-text
SearchControl instead of the multi-select picker. Lance reported
"users have no way of knowing what to input other than the year
filter" -- prior to investigation we'd assumed this was a UX gap
where pickers needed to be wired up; the actual fault was that
the picker code path is correct but was never seeing non-empty
filter values.

Root cause: `api.getFilterValues` was fanning out to ALL 8 Plex
sections (movies + TV + music + audiobooks) instead of just the
movie libraries. Plex returns `200 OK` with the `Directory`
field OMITTED (not `[]`) for a non-applicable library --
Audiobooks returns no `Directory` for the 'genre' filter,
Anime 4K returns no `Directory` for filters with no values,
etc. The subsequent merge ran
`merged.Directory.push(...next.Directory)` against
`next.Directory === undefined` and threw `TypeError: next.Directory
is not iterable`. The error bubbled up as `requestFilterValuesError`
to the client, whose reducer set `filterValues[key] = []`, which
falls through to SearchControl in FilterPanel.

Reely is movies-only by design (audit 8 #127) so the fix is
to filter `api.getLibraries()` to movie type before the fan-out
(matching what the provider layer was already doing for media
fetches). Also defensively guard the `Directory` merge against
Plex omitting the field even on a movie library that
legitimately has no values for a given filter.

Affects genre, year, decade, collection, contentRating, and any
other filter with enumerated Plex values. All of them now render
as multi-select pickers.

### Added (rating filter, 10-bucket multi-select)

Plex's native rating buckets via `/library/sections/<key>/rating`
are coarse 5-star (10, 8, 6, 4, 2, -1). The owner asked for finer
1-unit buckets (0.0-0.9, 1.0-1.9, ..., 9.0-9.9) for selecting
movies by quality.

Implementation: synthesized server-side. The provider injects a
`rating` entry into the filter list (alongside the synthetic
`library` filter) with type `integer`; `getFilterValues('rating')`
returns 10 bucket entries. The post-filter pass in `getMediaCached`
runs after the Plex fetch + Media[] mapping: each movie's rating
is bucketed via `Math.floor(rating)` and compared against the
user's selected bucket set. `'='` operator means "in one of these
buckets"; `'!='` means "in none of these buckets". Unrated movies
never match a rating filter on either operator.

Plex's per-movie rating field is already on a 0-10 scale (e.g.
"2 Fast 2 Furious" → rating 3.7), so reely's existing
`Media.rating: number | undefined` and the
`libraryItem.rating != null ? Number(libraryItem.rating) :
undefined` mapping in the provider don't change. No wire shape
change. No type change. No client change. No locale change.

### Tests
- No new tests yet. Suggested follow-up: extend
  `tests/providers/plex.test.ts` with (a) a getFilterValues case
  exercising a library that returns `Directory: undefined`
  (regression for the production bug), and (b) a getMediaCached
  case verifying the rating post-filter selects the right buckets.
  723/723 unchanged.

## [0.5.22] - 2026-05-26

### Fixed (rate-storm dedup over open socket; 0.5.20 follow-up)

0.5.20 added a `pendingRates` dedup-by-mediaId so a stuck client
couldn't fill the offline queue with same-card duplicates. That
fix covered the `ws.readyState !== OPEN` path only. Production
reely 0.5.20 on galactica (Lance on Android phone + tablet,
2026-05-27 ~02:55 UTC) still tripped the WS 100/10s rate limit
three times in one minute -- the storm was firing over an OPEN
socket, going straight to `ws.send()` with no dedup.

Fix: new `sentRateIds: Set<string>` on `ReelyClient`; `rate()`
short-circuits if a mediaId is already in the set, then adds it.
Once a card is rated, no valid use case for re-rating exists in
the same room (the card is removed from the deck client-side),
so strict drop-on-duplicate is safe. The set is cleared on
`joinRoom` / `joinOrCreateRoom` / `createRoom` so a user moving
to a different room (or auto-rejoining after a long
disconnect) starts fresh. Memory is bounded by the library
size; no expiry needed within a session.

### Added (username-taken-in-room rejection)

Lance reported same-name multi-device joins silently froze the
older device. The displaced client was still connected but its
rate dispatches got silently dropped by the `room.users.get
(userName) !== this` active-connection guard -- user sees the
top card never advance and assumes the app is broken.

Fix: `joinRoomFromSanitized` now rejects the join if the
requested username is already in use by a DIFFERENT live
connection in the same room. New `UsernameTakenError` thrown
through the existing emit-error path; `JoinRoomError['name']`
extended with `"UsernameTakenError"`; client UI shows the
server-supplied message verbatim (`"Lance" is already in this
room. Pick a different name.`) in the Login screen's existing
error box. Lance can pick a different name on the second
device or close the first one. No protocol close-codes, no
new ServerMessage variants, no reducer rework -- just the
existing join-error rendering path.

### Added (filtered empty-stack message)

When a user's swipe deck runs out with filters applied, the
empty-state message was always `"That's all folks ✌️"` --
cute but not informative. The user might not realize the deck
is the FILTERED set, not the whole library. New i18n key
`RATE_SECTION_EXHAUSTED_CARDS_FILTERED` shown when
`room.activeFilters.length > 0`:
- en: "Adjust your filters to see more."
- de: "Passe deine Filter an, um mehr zu sehen."
- es: "Ajusta tus filtros para ver más."
- fr: "Ajuste tes filtres pour en voir plus."
- nl: "Pas je filters aan om meer te zien."
- pl: "Dostosuj filtry, aby zobaczyć więcej."

(My translations; per audit-14 #349 policy, locale authors
own quality. Native-speaker revision welcome.)

### Tests
- No test changes. 723/723 unchanged. Lance is testing the
  username-taken flow live on the Android phone + tablet pair.

## [0.5.21] - 2026-05-26

### Dependencies (Dependabot weekly drop, consolidated)

First weekly drop under the `update-types: [minor, patch]` group
config (`.github/dependabot.yml`, dev branch commit `d6ab167`).
Both PRs were clean minor+patch bundles -- exactly what the
config change was supposed to produce. Closed in favor of this
consolidated 0.5.21 bump so the version-bump rule for main
pushes is honored (Dependabot's direct-to-main merge would
have skipped that).

Runtime group (PR #8 -- closed):
- `helmet` ^8.0.0 -> ^8.2.0 (minor)
- `ws` ^8.20.1 -> ^8.21.0 (patch)
- `zustand` ^5.0.12 -> ^5.0.13 (patch; root devDep)
- `zustand` ^5.0.3 -> ^5.0.13 (patch; web/app dep)

Dev group (PR #9 -- closed):
- `tsx` ^4.19.2 -> ^4.22.3 (patch series within v4)
- `vitest` ^4.1.5 -> ^4.1.7 (patch)
- `vite-plugin-pwa` ^1.2.0 -> ^1.3.0 (minor; web/app devDep)

No major-version bumps mixed in (express 5, react 19, typescript
6, @vitejs/plugin-react 6, @types/node 25 all stayed out per the
new group filter). Those will surface as individual solo PRs in
future weeks and can be triaged on their own merits.

### Tests
- No test changes; dep-bump only. 723/723 unchanged under the
  new versions. Lint + typecheck clean.

## [0.5.20] - 2026-05-26

### Fixed (pendingRates dedup-by-mediaId; production post-mortem from 0.5.9)

Production reely 0.5.9 on galactica (2026-05-27 ~02:30 UTC)
logged 95+ "already rated" warnings for the same mediaId from a
single user (Lance1), tripping the WS message rate limit
(100/10s) three times across a reconnect-cycle storm. Traced to
the `pendingRates` queue: while disconnected, a stuck client
(key-held-down, render loop, or any cause that fires `rate`
dispatches in a tight loop) fills the FIFO queue to its 50-entry
cap with copies of the SAME mediaId. On reconnect, all 50 flush
in a sub-second burst -- server records the first as a new
rating, the rest hit the `storeRating` "already rated" guard +
log warnings. If the client re-disconnects mid-flood, the cycle
repeats with another 50 duplicates.

Fix: `sendMessage` in `web/app/src/api/reely.ts` now dedupes by
`mediaId` before enqueueing a `rate`. Same-mediaId queues to one
slot (replaced in place, last-rating-wins -- if a user reverses
while offline, the latest decision is what flushes); different
mediaIds still push + cap to 50 as before. The queue is now
bounded at the number of DISTINCT cards rated while offline, not
the number of dispatches. Flush path (audit-12 #286 mid-flush
re-queue) is unchanged.

Defense-in-depth only -- the underlying client-side loop that
caused the storm in the first place (stale closure on a keyboard
handler? render-cycle bug? long-disconnect autoplay?) is a
separate diagnosis. The server's `storeRating` guard + WS rate
limit caught the symptom correctly; this just keeps the queue
from amplifying it. Watch the production logs after deploy --
a recurrence with this fix in place would point at a different
code path.

### Tests
- No new tests in this commit. Suggested follow-up: extend
  `tests/web/reelyClient.test.ts` "sendMessage + pendingRates"
  suite with same-mediaId-flood + mixed-mediaId-cap cases.
  723/723 unchanged.

## [0.5.19] - 2026-05-25

### Maintenance (audit 15 medium batch 3/3: web layer)

#386 -- `Room.tsx` `pendingStack` mapping and `<UsersPopup>`
hoisted above the desktop/mobile branching. Both JSX nodes were
duplicated character-for-character across the two render
branches; pulled into local consts (`matchMomentStack`,
`usersPopup`) above the if/else so each appears once. Container
placement still differs per branch (matchMomentStack lives in
`.desktopSwipeStage` on desktop vs top-level on mobile;
UsersPopup is at the branch's end in both cases).

#389 -- `reducer.ts` `addErrorToast(state, message)` helper
extracted. Four error cases (`filterChangeError`,
`leaveRoomError`, `logoutError`, `requestFiltersError`) shared
the same toast-counter bump + push-with-Failure-appearance
pattern. Each case dropped from a 9-line return to a one-liner
spread. `requestFiltersError` keeps its additional
`availableFilters: { ... }` reset after the spread.

#391 -- **DEFERRED** with documented analysis. The two
`useEffect`s in `FilterPanel.tsx` (lines 63 + 81) look duplicative
but encode distinct concerns: one handles the `false → true`
`isOpen` transition (re-sync draft + prefetch values), the other
handles mount-time prefetch on desktop where FilterPanel is
permanently mounted regardless of `isOpen`. Unifying them either
loses the mount-time prefetch (UX regression on desktop),
introduces redundant `setDraft` re-renders, or adds more
ref-tracking than the duplication removes. Audit's "unify into
one keyed on isOpen" doesn't survive the dual-purpose read;
revisit if FilterPanel changes the mount-vs-toggle model.

#393 -- **NO-OP after skim.** `Room.test.tsx` and
`Room.desktop.test.tsx` are split by matchMedia stub (false vs
true); overlap is limited to UsersPopup wiring + match-celebration,
both of which verify each viewport's specific orchestration around
the shared organism. Parameterizing would require layout-specific
test paths anyway (match strip on mobile vs matches sidebar on
desktop), so the ~20% duplication is the cost of explicit per-
viewport testing. Viewport split kept.

### Tests
- No test changes; Room.tsx hoist preserves DOM shape, addErrorToast
  preserves observable state shape. 723/723 unchanged.

## [0.5.18] - 2026-05-25

### Maintenance (audit 15 medium batch 2/3: schema + types + cross-cutting)

#383 -- `config/validate.ts` `requireString(value, errors,
ErrorClass, message)` helper extracted. Replaces 9 sites of
`typeof X !== 'string'` + `errors.push(new SomeError('...'))`
boilerplate with a type-narrowing predicate. Mixed sites
(string + non-empty / + starts-with-/ etc.) keep the extra
check inline after the type narrow.

#385 -- `internal/app/plex/types/libraries_list.ts` narrowed
from 53 to 23 lines. `PlexLibrary` shrinks from 19 fields to
the 3 actually read (`key`, `title`, `type`); `Libraries`
shrinks from 7 fields to the 1 actually read (`Directory`);
`Location` interface dropped entirely. Same prune pattern as
audit 15 #370 (library_items.ts in 0.5.11); raw Plex wire shape
can carry extra fields without TS caring at runtime.

#392 -- new `types/sanitize.ts` carrying the shared regex
constants (`STRIP_DANGEROUS`, `ROOM_NAME_ALLOWLIST`,
`ROOM_NAME_MAX_LEN`). Both the server's
`internal/app/reely/util/sanitize.ts` and the web's
`web/app/src/utils/sanitize.ts` now import from it -- previously
each maintained its own copy and they had drifted on flag use
(server `/gi`, web `/g`) and on whether the strip pass was one
alternation or five sequential `.replace()` calls (server got
the alternation form in #380; web stayed on five passes until
this batch). Drift now structurally impossible.

### Tests
- No test changes; observable behavior preserved across all
  three items. `sanitize.test.ts` inputs verified equivalent
  under the shared single-pass regex; `validate.test.ts`
  asserts error CLASS NAMES (not messages), so #383's slight
  message tightening is invisible. 723/723 unchanged.

## [0.5.17] - 2026-05-25

### Maintenance (audit 15 medium batch 1/3: server-internal cleanup)

Six small refactors across the server / shared util layer. All
behavior-preserving consolidation; no observable API change.

#378 -- `room.ts getMatches` now walks each rating tuple once
(audit 15). The prior body did three passes over each rating
(filter + reduce + find); one for-loop now collects likers,
tracks latest matchedAt, and detects whether userName is among
the likers.

#379 -- `handlers/poster.ts` collapsed two near-identical 404
guards (one for the providerIndex regex check, one for the
out-of-bounds check) into a single ternary + one guard. Same
behavior: an invalid regex result becomes `undefined`, which the
guard catches alongside out-of-bounds indices.

#380 -- `util/sanitize.ts` sanitizeInput collapsed five sequential
`.replace()` passes into one alternation regex. Per-rule comment
documentation preserved as a comment block above the regex. One
pass over the input instead of five.

#381 -- `util/memo.ts` consolidated `memo1` and `memo1TTL`. The
two helpers shared ~80% logic; `memo1` is now a one-line wrapper
that calls `memo1TTL(fn, Number.POSITIVE_INFINITY, maxEntries)`.
`memo1TTL` generalized to accept any `T` (was `Promise<T>`); the
Promise-rejection cleanup is gated on `instanceof Promise`.
Existing tests + i18n.ts caller unchanged.

#382 -- `util/assert.ts` `ReelyUnknownError` now extends
`ReelyError` (was: extends `Error`) so it inherits the
`this.constructor.name` constructor that the 21 config-error
subclasses also rely on. No `instanceof ReelyError` /
`ReelyUnknownError` callers exist, so the prototype-chain change
is invisible. Observable behavior unchanged.

#384 -- `safeProgress(count, total)` helper extracted into
`room.ts` and imported in `client.ts`. Three duplicated guard
sites (client.ts handleJoinRoom, room.ts storeRating, room.ts
getUsers) now share one definition: returns 0 when total is 0
or negative so the wire value can't become Infinity / NaN on a
degenerate empty-media room.

### Tests
- No test changes; six refactors are observable-behavior-preserving.
  723/723 unchanged.

## [0.5.16] - 2026-05-25

### Maintenance (audit 15 #390: api/reely.ts request<K> helper)

Eight nearly-identical request methods on `ReelyClient` shared
the same three-step pattern: `await this.waitForConnected();
this.sendMessage(msg); return this.waitForAnyMessage(replyTypes)`.
Extracted as a private `request<K>(msg, replyTypes, match?)`
helper. Each caller dropped from a 5-line boilerplate to a single
delegating call. The shared correctness invariant (open-socket
gate before send, close-event rejection mid-wait, 15s timeout)
now lives in one place. `requestFilterValues` additionally passes
a matcher to correlate the key-bearing response with its caller;
that shape is preserved by the helper's optional third arg.

Untouched (different shapes): `rate` (no `waitForConnected`, has
internal queue handling for disconnect), `setLocale` (no awaited
reply), `applyFilters` (no awaited reply -- relies on the
`filterChangeApplied` broadcast).

### Tests
- No test changes; reelyClient tests target the underlying
  `waitForConnected` / `sendMessage` / `waitForAnyMessage`
  primitives, not the higher-level request methods. 723/723
  unchanged.

## [0.5.15] - 2026-05-25

### Maintenance (audit 15 #387 + #388: frontend inline-style hoisting)

#387 -- `MatchesList.tsx` per-avatar inline styles -> CSS module
classes. Each rendered match row built two inline style objects
per avatar (3 avatars/row * 2 objects = 6 fresh objects per row,
all static-shaped) -- a fresh allocation cycle per render. Moved
to `.avatarWrap` + `.avatarScale` in MatchesList.module.css; JSX
keeps the existing `styles.avatarOffset` composition for the
overlap stacking. Identical computed layout.

#388 -- `MatchMoment.tsx` 20 confetti-piece style objects hoisted
to module-scope `CONFETTI_PIECES`. Values are pure functions of
the iteration index, so per-overlay-open re-allocation was pure
waste. The big-overlay variant re-renders this list on every
state change (Esc gating, etc.) and on every match remount, so
the savings compound. Test `[class*="confettiPiece"]` and
`length === 20` invariants preserved.

### Tests
- No test changes; both modifications are render-allocation
  cleanup that preserves DOM shape + class names. 723/723
  unchanged.

## [0.5.14] - 2026-05-25

### Maintenance (audit 15 #373 + #397: small server bundle)

#373 -- `@testing-library/jest-dom` removed from root devDeps.
The dep was carried since the jsdom + RTL harness landed (0.4.34)
but never imported -- jsdom + RTL alone cover every render
assertion in the suite, and one test file explicitly notes
"no jest-dom matchers imported here." Pure dead dep. `pnpm
remove` cleared it plus 8 transitives from the lockfile.

#397 -- `handlers/basic_auth.ts` length-normalization swapped
from `createHmac('sha256', HMAC_KEY)` to `createHash('sha256')`.
The HMAC key was hardcoded (`'reely-basic-auth-compare'`) and
never used as a secret -- the prior comment explicitly said so.
HMAC is overkill when the goal is "hash both sides to equal
length before timingSafeEqual"; a plain SHA-256 hash does the
same job with one fewer crypto op per auth request. Constant-
time compare preserved; no security tradeoff. Comment block
updated to document the length-normalization rationale +
audit-15 reference.

### Tests
- No test changes; both modifications surface only at internal
  implementation level. 723/723 unchanged.

## [0.5.13] - 2026-05-25

### Maintenance (audit 15 #377: room.ts arrow-props -> methods)

Twelve class fields written as arrow-function expressions in
`internal/app/reely/room.ts` converted to ordinary class methods.
Arrow-function-as-class-field captures `this` lexically by
allocating a per-instance closure at construction; for methods
that are only ever invoked via `room.X(args)` (no detached
reference, no `.bind`, no callback-passing) that allocation is
pure overhead. Room is constructed per active room; the per-
instance fn overhead was small but real and the lexical-this
binding was never used.

Converted: `fetchMedia` (private), `applyFilters`,
`getMediaForUser`, `storeRating`, `getMatches`, `getUsers`,
`notifyJoin`, `notifyLeave`, `notifyProgress`, `notifyMatch`,
`notifyFilterApplied`, `broadcastMessage`.

Behavior unchanged. Tests' `room.notifyMatch = mockFn` mock
pattern still works (assigns an own-property that shadows the
prototype method at lookup).

### Tests
- No test changes; mechanical refactor. 723/723 unchanged.

## [0.5.12] - 2026-05-25

### Maintenance (audit 15 #372 + #376: client.ts dup-extractions)

#372 -- consolidate three near-identical room-request validation
blocks (`handleCreateRoom` + `handleJoinRoom` + `handleJoinOrCreateRoom`)
behind one `validateRoomRequest(req, errorType)` helper. Each call
site dropped from ~14 lines of payload-shape guard + sanitize +
re-guard to 2 lines. `handleLogin`'s similar-shape userName
validation stays inline -- its sanitize function, error vocabulary,
and field name diverge enough that a fully generic helper would
have more params than the call sites.

#376 -- room-cleanup paths consolidated. `leaveRoomCleanup` now
returns `Room | undefined` (was `boolean`); the returned reference
lets callers persist or mutate the prior room after the detach.
- `handleLogout` no longer duplicates eviction logic; calls the
  helper instead.
- `handleLogin` rename branch uses the returned reference instead
  of capturing `this.room` manually before the helper call.
- `handleLeaveRoom` unchanged (truthy/falsy still gates the
  success / NOT_JOINED response).

### Fixed (latent bug surfaced by #376)

`handleClose` previously called `leaveRoomCleanup()` (which sets
`this.room = undefined` on success) and then checked
`if (this.room) void saveRoom(this.room)` -- always false, so the
disconnect-time save never ran. Per-rating debounced
`scheduleSaveRoom` covers normal activity; the dead disconnect
save mostly mattered for "save now" semantics on unclean
disconnects. After the #376 refactor, `handleClose` captures the
returned room reference and the save actually fires.

### Tests
- No test changes; client.ts dup extraction + dead-code fix.
  723/723 unchanged.

## [0.5.11] - 2026-05-25

### Maintenance (audit 15 #370 + #371: Plex types prune)

#370 -- `internal/app/plex/types/library_items.ts` was 256 lines,
~80% dead types. The file describes the Plex /library wire format
but reely only reads ~15 of its 50+ fields. Pruned to 76 lines:
- `LibraryItems` narrowed to the 3 fields actually accessed
  (`size`, `Metadata`, optional `Meta`).
- `LibraryItem` narrowed to the 11 read fields; 19 unread fields
  dropped (Media/Part/Director/Writer/Country/Role/Collection/
  audio-video-codec/frame-rate/chapter-source/etc.).
- `Type`, `Filter`, `Field` (all internal, never imported by name)
  narrowed to read fields only.
- 12 nested type aliases dropped entirely (Sort, ActiveDirection,
  Media, Part, AudioProfile, Container, VideoProfile, AudioCodec,
  VideoCodec, VideoFrameRate, ChapterSource, ContentRating).

External imports unchanged: `api.ts` pulls `LibraryItems` + `Meta`;
`providers/plex.ts` pulls `FieldType`.

#371 -- `internal/app/plex/types/identity.ts` deleted. Zero
importers; its `Identity` interface was replaced by
`capabilitiesCache` in api.ts (machineIdentifier + version come
off the `/` capabilities response now, not `/identity`).

### Tests
- No test changes; types-only refactor. 723/723 unchanged.

## [0.5.10] - 2026-05-25

### Maintenance (audit 15 #369: CHANGELOG primary condensed)

Audit 15's #1 finding -- the primary CHANGELOG was 4,543 lines for
a 0.y.z app with a 102-line README. Moved 0.3.7 - 0.4.50 detailed
entries to `docs/CHANGELOG-archive.md` (which already held
0.1.0 - 0.3.6 since 0.4.7 / audit 10 #174). The 0.4.x and 0.3.x
ranges now appear in primary as themed y-version summaries.

Policy going forward: a y-version's per-release detail stays in
primary until the next minor cuts; at rollover the just-completed
y-version's entries move to the archive en masse and are replaced
by a single summary block here. Documented at the top of this
file + in the archive's intro.

Archive grew from 1,129 lines to ~5,140; primary shrank from
4,543 to ~620.

### Tests
- No code changes; 723/723 unchanged. Docs only.

## [0.5.9] - 2026-05-25

### Fixed (Share button width pop on "Copied!")

The Share button in the Room top bar / bottom bar visibly resized
each time it was pressed: the label flipped between "Share" (5
chars) and "Copied!" (7 chars), and with no width reservation the
button width snapped to whichever label was active. Reported by
the owner.

Fix: render both labels inside an inline-grid wrapper, stacked in
the same cell. The inactive label is `visibility: hidden` so it
doesn't draw but still contributes to the cell's intrinsic width.
The button now always reserves max("Share", "Copied!") width and
stays stable through the flip. Pure CSS, no JS measurement.
`aria-hidden` toggles between the two spans so the active label
is the one that participates in the accessible tree; the outer
`aria-label="Copy room link"` on the button is unchanged.

Both ShareButton call sites (desktop top bar `.desktopShareBtn`,
mobile bottom bar `.mobileShareBtn`) share the single component,
so both branches benefit from the one fix.

### Tests
- `Room.test.tsx`: tightened the "label flipped to Copied!"
  assertion to query the visible (`aria-hidden="false"`) span
  specifically, since both labels now always live in the DOM.
  723/723 unchanged.

## [0.5.8] - 2026-05-24

### Docs
- `docs/branding/README.md`: corrected the Unraid icon URL
  section. The 0.5.6 entry recommended a GitHub
  user-attachments URL as the "private-repo stopgap" -- that
  doesn't actually work; GitHub returns 403 to anonymous
  fetches when the source repo is private (Galactica webgui
  error: "Could not download icon ..."). Updated to point at
  the actual working URL (self-hosted at
  http://www.cajunflavoredbob.com/reely-logo-512.png) +
  documented why the user-attachments trick fails in this
  case + listed the other stopgap options (Imgur, public
  gist) for anyone else hitting the same.

### Tests
- No code changes; 723/723 unchanged.

## [0.5.7] - 2026-05-24

### Changed (MatchMoment: new toast replaces existing instead of queueing)

Per the owner's feedback after 0.5.6 landed the slide animation: "the
new match notification needs to slide down on top of the existing
one. The new notification replaces the previous one."

0.5.6 and prior: matches FIFO-queued (audit 11 #178). m1 ran its
full 3s lifespan before m2 mounted and slid in. User had to wait
through m1 to see m2.

0.5.7: matches stack. New match mounts immediately, slides in on
top of the older one. The older one is "demoted" via a new
`replaced` prop on MatchMoment that applies a `.toastReplaced`
class -- a 200ms opacity fade in place (pure opacity, no
transform, since sliding the demoted toast out would visually
fight the new one's slide-in). 400ms after demotion, Room's
auto-prune effect unmounts the demoted toast. Net effect: at any
steady state only the topmost match is mounted; the transient
two-toast stack exists only during the 400ms transition window.

**Trade-off (explicit reversal of audit 11 #178):** rapid back-to-
back matches no longer each get their own 3s celebration window.
The latest preempts. The matches list (sidebar / popup) is still
the canonical record of every match; the toast is for the
active-notification feel only. Comments in Room.tsx and this
CHANGELOG flag this so the audit-11 rationale isn't lost.

### Tests
- `MatchMoment.test.tsx`: +2 tests for the `replaced` prop -- no
  auto-dismiss when replaced, and the `.toastReplaced` class is
  applied on the toast div.
- `Room.test.tsx`: rewrote the audit-11 FIFO-queue test as a stack
  test -- new assertion: when 2 matches arrive in one tick, BOTH
  render (newest on top with `data-is-big=true` + non-replaced,
  older underneath with `data-replaced=true`); dismissing the top
  clears the entire stack. Stub gained a `data-replaced` attribute
  to surface the new prop.
- Total: 723 (was 721; net +2 -- +2 MatchMoment, +0 Room (1 old
  test replaced by 1 new combined test)).
- Typecheck + lint clean.

## [0.5.6] - 2026-05-24

### Fixed (MatchMoment toast on mobile -- slot landing 64px too low)

0.5.5 finally got the slide-and-fade animation actually firing
(the keyframe-name-hashing fix). With that in place, the visual
bug remaining was that on mobile the toast dropped down WAY
below the top bar instead of sitting flush with the header's
bottom edge.

Root cause: `.toastSlot`'s `top` value was
`calc(max(env(safe-area-inset-top), 4rem) + 52px)` -- evaluating
to ~116px. The actual header bottom is at y=50px. So the slot
was landing 66px below where it should. Two errors compounded:

1. The calc assumed `.screenLayout`'s `padding-top: 4rem` (=
   64px) applied. But Room's `.screen` class overrides
   `.screenLayout`'s padding to `0px 0px <bottom> 0` -- zero
   on top. So the +4rem was a phantom 64px gap.
2. The `+52px` was a mis-measure of header height (assumed
   Logo size 28 -> 12+28+12). Actual: Logo is 24, but UserPill
   is 26 (taller). Header = 12 + 26 + 12 = 50px.

Fixed: `top: 50px` flat on mobile. Detailed comment in the
CSS lists the invariants (UserPill height, Logo size,
mobileTopBar padding, .screen's padding-top) that would
invalidate the value if changed.

### Added (branding assets)

`docs/branding/` -- already populated with the SVG master +
PNG exports (512, 1000 dark, 1000 light, 32-preview). 0.5.6
appended an "Unraid container icon" section to the existing
README documenting the GitHub user-attachments URL (stable
anonymous-readable CDN URL, works while the repo is private)
+ the eventual public `raw.githubusercontent.com` URL for
post-1.0 swap. Same URL works for Docker Hub repository
overview Markdown.

### Tests
- No test changes -- CSS-only fix; the layout math IS the
  test (jsdom can't compute resolved CSS values either way).
- 721/721 passing, typecheck + lint clean.

## [0.5.5] - 2026-05-24

### Fixed (every CSS animation referenced from a .module.css was silently dead)

Vite's CSS Modules implementation hashes the `animation-name`
reference inside `.module.css` files (`animation: foo 200ms` becomes
`animation: _foo_<hash>_<n> 200ms`) but does NOT hash `@keyframes`
defined in the global `main.css`. The names don't match -> the
animation silently no-ops. No error, no warning, no test failure.

This was the actual bug behind the toast slide that 0.5.2 / 0.5.3 /
0.5.4 chased. The toast was never animating at all -- it wasn't a
positioning problem, it wasn't a clipping problem, it wasn't an
opacity-cue problem. The reference name and the keyframe name simply
weren't the same string in the browser. Three releases of "fixes"
were rearranging deck chairs on a feature that physically could not
execute.

Worse: this bug affected EVERY animation that lived in `main.css`
and was referenced from a `.module.css`. Five sites across four
modules had been silently dead since they were written:

- `ry-slide-fade-in` + `ry-slide-fade-out` (MatchMoment toast)
- `ry-pop-in` (MatchMoment celebration overlay -- headline + poster
  pop-in, 2 sites)
- `ry-float-up` (MatchesList rows ×2, FilterPanel, Card,
  MatchMoment celebration backdrop -- 5 sites across 4 modules)

`ry-confetti-fall` was the lone survivor because it happens to be
defined INSIDE `MatchMoment.module.css` rather than in main.css --
so its reference and definition got the same hash and it resolved
correctly. That's why it was the only MatchMoment animation
visibly firing.

Fix: moved every affected `@keyframes` from `main.css` INTO the
`.module.css` that references it. The reference and the definition
now get the same hash, so the name resolves. `ry-float-up` is
duplicated into 4 module files (~16 lines added total) -- redundant
but isolated. Verified at the bundle level: every
`@keyframes _ry-*_<hash>_1` definition now has a matching
`_ry-*_<hash>_1` reference (`pnpm build:ui` + grep dist/web).

Left a STRONG warning comment in `main.css` where the keyframes used
to live, documenting the failure mode + the workaround, so the next
time someone considers adding an `@keyframes` to the global
stylesheet they see the warning instead of repeating the bug.

### Discovered by
Two parallel subagents (one inspecting the built CSS bundle, one
walking the CSS Modules config + ancestor chain) independently
converged on the same root cause within ~2 minutes. The bundle
inspection found the smoking gun -- a `_ry-slide-fade-in_tqk7e_1`
reference with no matching keyframe definition. Worth remembering
that "the animation property is wrong" is a different debug step
than "the animation isn't visible." The latter doesn't always imply
the former.

### Tests
- No test changes needed -- jsdom can't compute CSS animations, so
  this entire class of bug was invisible to the existing test
  suite. Future-proofing would require either a real-browser test
  harness (Playwright/Cypress) or a build-output regression check
  asserting that every `animation-name` resolves to a known
  `@keyframes` in the bundled CSS. The latter is doable as a small
  Vitest test that reads dist/web/assets/*.css -- worth considering
  if this bug recurs in any form.
- 721/721 passing, typecheck + lint clean.

## [0.5.4] - 2026-05-24

### Fixed (MatchMoment slide actually readable as motion)

0.5.3 fixed the toast slot's POSITIONING so the geometry was
correct -- the toast was technically sliding from behind the
header. But the slide read as "just appears" because:

- 320ms is fast for a short-distance slide.
- Pure translate within an overflow:hidden clip means the eye
  sees a height-growing element, not a moving one -- the toast
  body doesn't change position as it slides; only the visible
  fraction of it does.
- No opacity change = no second motion cue.

Fixed: 600ms entry (was 320ms) + 350ms exit (was 200ms) +
opacity fade layered on the slide. The eye needs both motion
AND opacity to register a slide at short distances; with the
fade added, even a 200ms version would have been visible, but
600ms gives the springy bezier overshoot room to read as
snappy-not-slow.

Renamed `ry-slide-down` -> `ry-slide-fade-in` and `ry-slide-up`
-> `ry-slide-fade-out` so the keyframe names reflect the
actual visual effect.

### Added (UsersPopup)

- Version label in the "In this room" header, sitting just to
  the left of the close button. Pulled from
  `document.body.dataset.version` (already wired through
  `index.html`'s `${version}` template that the server
  substitutes at request time). Renders only when a real value
  is present so jsdom tests stay clean.
- Close button got the MatchMoment toast-close treatment:
  40x40 gradient-pink pill, hover-brighten + active-scale.
  The prior 28x28 bare-icon button was hard to tap on mobile
  + didn't read as a primary affordance. Sharing the pill
  idiom across dismissable surfaces (MatchMoment toast +
  UsersPopup) makes the close X feel consistent everywhere.
- Switched the popup's close icon from its custom offset path
  (`M3 3l10 10M13 3L3 13`) to the shared `<CloseIcon size={16}
  strokeWidth={2.5} />` atom -- the offset path read awkwardly
  inside the new pill bounds.

### Tests

- `MatchMoment.test.tsx`: bumped auto-dismiss timer to
  3000+350ms and click-dismiss timer to 350ms to match the
  new TOAST_EXIT_MS.
- `UsersPopup.test.tsx`: added a version-label render test.
  Uses `vi.resetModules()` + dynamic re-import to force
  `APP_VERSION` to re-read `document.body.dataset.version`
  after the test sets it (APP_VERSION is module-scoped to
  match production behavior where the dataset is set
  once-at-page-load by the server).
- Total: 721 (was 720; +1 version-label test).

## [0.5.3] - 2026-05-24

### Fixed (MatchMoment toast slide actually visible now)

0.5.2 introduced the `.toastSlot` clipping wrapper + the
slide-down / slide-up keyframes, but **the slot was
positioned wrong** -- so the slide animation was happening
but not where the user could see it as "from behind the
header." Two-line CSS fix:

- **Mobile**: `.toastSlot` top was `64px` -- the same as
  `.screenLayout`'s `padding-top` (`max(env(safe-area-
  inset-top), 4rem)`). Since the slot is `position:
  absolute` inside `.screenLayout` (which is `position:
  relative`), `top` is measured from the layout's
  padding-box top (= viewport top). So `top: 64px` landed
  the slot AT the same y where the header starts inside
  the padding -- the slot overlapped the header instead of
  sitting below it. Fixed: `top: calc(max(env(safe-area-
  inset-top), 4rem) + 52px)` -- adds the header's ~52px
  height (12px + Logo 24px + 12px) so the slot's top edge
  is flush with the header's bottom edge.
- **Desktop**: `.toastSlot` top was `8px` inside
  `.desktopSwipeStage`. The stage starts directly below
  `.desktopTopBar`, so `top: 8px` left a visible 8px gap
  above the slot's top edge -- the toast appeared 8px
  below the header instead of emerging from behind it.
  Fixed: `top: 0` so the slot's top edge is flush with
  the stage top edge (= header bottom).

With both edges flush, the `overflow: hidden` clip on the
slot now visually clips the toast at the header's bottom
edge -- so when the toast translates from `translateY(-100%)`
to `translateY(0)`, it appears to emerge from behind the
header bar.

### Tests
- Total: 720 (no change). CSS-only fix; no behavior
  observable in the headless test suite. Visual fix
  verified by the rendering layout-math (no tests added
  -- the layout math IS the test).

## [0.5.2] - 2026-05-24

### Changed (MatchMoment toast -- slide + dismissable polish)

Three coordinated changes to the MatchMoment toast (the
"new match" notification on mobile + desktop). Behavior
that previously felt like "appears, then disappears" now
feels like "slides in from behind the header, slides
back out when dismissed."

- **Slide IN from behind the header** -- restructured
  the toast DOM to put the visual `.toast` inside a
  `.toastSlot` clipping wrapper (`overflow: hidden`).
  The clip-via-wrapper lets the toast translate from
  `translateY(-100%)` (fully hidden above the slot's
  top edge) to `translateY(0)` (rest position just
  below the header). No header z-index / background
  changes needed -- the slot's clip handles occlusion.
  - `main.css`: `ry-slide-down` redefined to
    `translateY(-100%) → translateY(0)` (was -20px
    with opacity fade). Removed the opacity fade --
    the wrapper clip handles invisibility cleanly.
- **Slide OUT on dismiss / timeout** -- new
  `ry-slide-up` keyframe (mirror of `ry-slide-down`).
  Triggered by adding a `.toastExiting` class to the
  toast. The MatchMoment component schedules a
  `setTimeout(onDismiss, 200)` to match the slide
  duration so the parent's unmount fires AFTER the
  animation completes. Previously the toast simply
  unmounted on dismiss / timeout (no exit animation).
- **Prominent X button** -- `.toastClose` was a plain
  icon button; now a 40×40 reely-gradient pill with
  the CloseIcon at size=16, strokeWidth=2.5. Bigger
  hit area for mobile taps + visual primacy that
  matches the toast's pink border.
- **Re-entry guard** on the dismiss path: if the
  auto-timer fires DURING a user click, or the user
  rapid-double-clicks, `onDismiss` still fires exactly
  once. Guarded by an `if (exiting) return;` in the
  `requestDismiss` callback.
- **Cleanup** on unmount-mid-exit: if the parent
  yanks the toast while the exit animation is in
  flight (e.g. user clicks through to the next
  pending match), the pending `setTimeout` is cleared
  so it can't fire on an unmounted component.

### Tests

- `MatchMoment.test.tsx`: 2 existing tests updated
  for the new exit-animation indirection
  (auto-dismiss + manual-click both now need a 200ms
  advance for `onDismiss` to fire); 1 new test for
  the re-entry guard (rapid triple-click fires
  `onDismiss` exactly once).
- Total: 720 (was 719, +1). Typecheck + lint clean.

### Notes

- The `TOAST_EXIT_MS = 200` constant in MatchMoment.tsx
  must stay in sync with the `ry-slide-up` duration in
  main.css. Comment at both ends.
- Big-overlay variant (the first-match celebration)
  is unchanged -- it's a full-screen presentation
  that unmounts immediately on dismiss, no slide-out
  appropriate.

## [0.5.1] - 2026-05-24

### Changed (mobile UX polish)

Three coordinated CSS fixes for the mobile room screen:

- **`web/app/src/components/screens/Room.module.css`** --
  `.mobileTopBar` bottom padding `0` → `12px`. The
  avatar pills were hugging the header's bottom edge;
  symmetric 12px top + 12px bottom gives the header
  proper breathing room.
- **`web/app/src/main.css`** -- new keyframe
  `ry-slide-down` (sibling to the existing
  `ry-float-up`). Element starts above its rest
  position (-20px) and slides DOWN with fade-in.
  Created for the MatchMoment toast (see next item) so
  the notification reads as emerging from below the
  header bar rather than rising from underneath.
- **`web/app/src/components/organisms/MatchMoment.module.css`**
  -- toast `top` `54px` → `64px` (clears the
  now-taller mobile header); animation `ry-float-up`
  → `ry-slide-down`. Same cubic-bezier bounce easing
  preserved. Desktop variant (top: 8px relative to
  desktopSwipeStage) unchanged.
- **`web/app/src/components/organisms/CardStack.module.css`**
  -- new `@media (max-width: 899px)` rule bumps
  `.stack` `padding-top` from `96px` → `120px` on
  mobile only. Gives the cardstack +24px breathing
  room from the header. Desktop unchanged (centered
  by `.desktopSwipeStage`).

CSS-only changes; no behavior change observable in
the test suite. Tests + typecheck + lint all clean
(719/719).

### Tests
- Total: 719 (no change). CSS-module class names are
  hashed at build time, so the existing tests that
  match on `[class*="..."]` patterns continue to find
  the right elements.

## [0.5.0] - 2026-05-24

**0.5.0 closes the 0.4.x stabilization arc.** No new
features land in this version -- it's a release marker
capturing the state after the audit cycles + coverage
uplift + deferred-item closures + close-out batches. dev
sits at this version awaiting the operator's release
direction.

### Stabilization arc summary (0.3.7 -> 0.5.0)

- **Four audit cycles closed.**
  - Cycle 1: audits 1-7 (#1-#84) closed across
    0.3.7-0.3.19.
  - Cycle 2: audits 8-12 (#85-#277) closed across
    0.4.1-0.4.14.
  - Cycle-2 closeout: 0.4.15 (#165/#226), 0.4.16
    (#237/#276), 0.4.18 (#217 fully).
  - Cycle 3: audits 13 + 14 (#278-#368) closed across
    0.4.19-0.4.25 (seven batches).
- **All cycle-3 deferred items closed.**
  - #338 per-module coverage uplift -- DONE for audit's
    scope in 0.4.45 (web-layer line). 0.4.49 + 0.4.50
    closed the documented-deferred caveats (Room desktop
    + handlers/health + handlers/serve_static).
  - #328 reducer counters into state -- 0.4.46.
  - #321 FilterPanel split (Option B partial:
    SearchControl + FieldPicker; FilterRow stayed inline
    per prop-count analysis) -- 0.4.47.
  - #299 cross-library filter dedup (Option A:
    server-side expansion lookup; zero wire-format
    change) -- 0.4.48.
- **Lint clean.** 0.4.26 drove 77 Biome warnings to 0;
  lint has stayed at 0 errors / 0 warnings since.
- **Tests: 0 -> 719** across the stabilization arc
  (vitest + the jsdom + RTL harness landed in 0.4.34).
- **CI gates.** GitHub Actions runs typecheck + build +
  test + Biome lint + pnpm audit + Trivy image scan on
  every push to dev. Release workflow (triggered by `v*`
  tags) adds a Trivy CRITICAL hard gate before the
  multi-arch Docker push.

### Deliberate-skip for 0.5.0

- **CardStack dismissal-callback path** (the last
  documented #338 caveat). The uncovered flow is
  `rateItem -> dispatch remove -> controller.start().then(onCardDismissed)`.
  The connection-status gate at the head of rateItem IS
  covered (0.4.43). The dispatch reaches the reducer
  (pure, tested elsewhere). The only uncovered link is
  whether react-spring's `Controller.start().then(cb)`
  actually invokes `cb` on animation completion -- a
  library-behavior question, not application logic.
  Adding a Controller-factory injection seam just to
  test library-call-through would change the SUT for
  testability without adding application-logic
  coverage. Revisit if a future batch adds a Playwright
  harness for orthogonal reasons.

### Carry-forward (post-0.5.0)

- **Emby / Jellyfin provider** -- planned for 1.0.
  Scaffolding intact: `User.avatarImage`,
  `ReelyProvider.isUserAuthorized()`, `servers` array
  form, `ProviderType` extension point. Inline
  SCAFFOLDING comments at each site (0.4.18+) to
  prevent re-flagging in future audits.
- **Docker Hub avatar upload** -- manual operator step
  via Hub web UI. Asset landed in
  `docs/branding/reely-logo-1000.png` (0.4.17).

### Won't-fix history

Carried forward from prior CHANGELOG entries; each is
documented inline at its source. Notable: #92 (audit
misread), #147 (already locked by 0.4.3 #98), #160
(would defeat mediaVersionCounter invariant -- now in
state per #328 but the invariant still holds), #167
(would orphan on-disk room files), #206 (already
bounded by MAX_ROOMS + per-conn rate limit), #238
(working as designed per EnvList contract), #259
(documented design choice), #342 (working as designed
-- release gate is the hard one), #347 (Dockerfile
apt-get upgrade reproducibility tradeoff -- documented
inline), #349 (cosmetic only), #354 + #355
(SCAFFOLDING, inline comments added in `e29a6f0`),
#364 (upstream react-spring v9 typedef gap, will
revisit on v10 bump).

### Tests
- Total: 719. No code change from 0.4.50; this entry
  is a release marker bump only (VERSION +
  package.json + CHANGELOG.md + docker-compose.yml per
  the 4-file rule).

## [0.4.x] - 2026-05-19 through 2026-05-24 (51 releases: 0.4.0 - 0.4.50)

The "audit cycles 2 + 3 + post-cycle" range. Detailed per-release
entries in [docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md).

### Highlights

- **Audit cycles closed.** Audits 8-14 (193 findings) closed across
  0.4.1 - 0.4.25. Audit-cycle-2 closeout (0.4.15 / 0.4.16 / 0.4.18)
  cleared the remaining PARKED items.
- **Movies-only scope** (0.4.1, #127): shows/music/photos dropped
  from types; `LibraryType` collapsed to the string literal `"movie"`.
- **Security:** Trivy CRITICAL hard gate on releases (0.4.18, #217);
  9 fixable CVEs cleared via `pnpm.overrides` + `ws` bump + base
  image bump + `apt-get upgrade -y` in runtime stage; bidi /
  zero-width sanitization on usernames (0.4.20, #295).
- **Performance:** parallel library fetch, in-memory `userRated`
  reverse index (0.4.25, #359), Plex pagination (0.4.25, #336),
  React.memo on hot atoms (0.4.25), `Object.fromEntries` over
  reduce-spread (0.4.25, #353).
- **Frontend state machine cleanup:** AbortController teardown for
  createStore listeners (0.4.22, #302), stale-localStorage race
  guard, exhaustive `dispatchToClient` switch, reducer counters
  moved into state (0.4.46, #328).
- **Condensing pass** (0.4.23, #281): CloseIcon atom, useEscape
  hook, cardStackGeometry helper, FilterPanel SearchControl +
  FieldPicker extraction (0.4.47, #321).
- **Filter cross-library dedup** (0.4.48, #299): per-provider
  expansion lookup; zero wire-format change.
- **Test coverage:** 259 -> 723 across the y-version. Audit 13
  #338 web-layer line closed in 0.4.45 (9 atoms + 2 molecules +
  5 organisms + 4 screens + 1 layout + useSelector under jsdom +
  RTL). Room desktop (0.4.49) + handlers/health + serve_static
  (0.4.50) close the documented caveats. Lone deliberate skip:
  CardStack dismissal-callback path (library-call-through, not
  application logic).
- **Build / CI:** Biome lint CI gate (0.4.21, #283), Dependabot
  weekly grouped PRs (0.4.13, #217), Node patch pin (0.4.7),
  GHA cache, multi-arch Docker build, vitest knobs.
- **Audit-protection inline comments** (0.4.18+): SCAFFOLDING
  annotations at `User.avatarImage` / Avatar avatarUrl /
  `ReelyProvider.isUserAuthorized` so future auditors don't
  re-flag the Emby/Jellyfin scaffolding.
- **0.4.0 UX polish:** user pills, users popup, card-stack
  peek-behind top card, button polish, mobile empty state.

Tests grew 259 -> 723. Lint went 77 warnings -> 0 (0.4.26 sweep).

## [0.3.x] - 2026-05-15 through 2026-05-19 (15 releases: 0.3.7 - 0.3.21)

Post-launch hardening + UX baseline. Pre-0.3.7 entries
(0.1.0 - 0.3.6) live in the archive; this block covers what was
in primary before this condensing pass. Detail in
[docs/CHANGELOG-archive.md](docs/CHANGELOG-archive.md).

### Highlights

- **Audit cycle 1 closed** -- audits 1-7 (84 findings) closed
  across 0.3.7 - 0.3.19. Highlights: filter-load hang fix,
  reconnect dup-user guard, reverse-proxy rootPath end-to-end
  (posters + Plex links + share URL), payload-shape guards on
  WS handlers, TTL sweep skips connected users (0.3.17, #4),
  `requestFilterValues` correlation by filter key (0.3.18, #12),
  timed auto-rejoin on WS reconnect within 10 min (0.3.19, #17).
- **Security:** `loadTranslation` path-traversal fix (0.3.3 era,
  in archive), browser setup flow removed (0.3.4 era, in
  archive); per-connection WS rate limit + `MAX_ROOMS` cap
  (0.3.5 era, in archive). The 0.3.7+ work in this block extended
  the same hardening pass.
- **0.3.20:** auto local/remote "Open in Plex" detection (single
  button, right URL based on client reachability of the Plex
  base URL).
- **0.3.21:** README filter FAQ + lowercase branding (Reely ->
  reely in docs) + match-consensus copy clarification.

Tests: 259/259 passing at the end of this y-version.
