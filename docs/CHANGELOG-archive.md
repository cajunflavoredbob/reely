# Changelog Archive (0.1.0 - 0.4.50)

Per-release entries split out of [`CHANGELOG.md`](../CHANGELOG.md) to keep
the active changelog readable. Two cleanup passes:
- 0.4.7 (audit 10 #174): moved 0.1.0 - 0.3.6 here.
- 0.5.10 (audit 15 #369): moved 0.3.7 - 0.4.50 here. Primary now
  carries per-release detail for the current y-version only; older
  y-versions appear there as themed summary blocks.

This file is reference-only -- no entries should be added here. When a
future cleanup pass wants to trim more from the active changelog (next
trigger: rollover to 0.6.0), append the target versions below in the
same reverse-chronological order.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html)

---

## [0.4.50] - 2026-05-24

### Added (test coverage)
- **`tests/handlers/health.test.ts`** (+3 tests) -- smoke
  coverage for the `/health` handler. Docker HEALTHCHECK
  polls this; an empty/non-200/missing-body response would
  flip the container to "unhealthy" silently. Pins HTTP
  200 + "reely is alive" body + synchronous (non-Promise)
  return. **Close-out batch 2 of 5 for the 0.5.0 release.**
- **`tests/handlers/serve_static.test.ts`** (+2 tests) --
  smoke coverage for the static-asset handler. Pins:
  - The export is a 3-arg express middleware function.
  - **`index: false` invariant**: the middleware falls
    through to `next()` for `/` requests rather than
    auto-serving `index.html`. This is the invariant that
    lets the template handler own SPA-shell serving with
    its rootPath / version / lang substitution -- if
    `index.html` were served raw by express.static, the
    browser would see literal `${...}` placeholders.

  Both files previously documented as "deliberately
  deferred -- trivial wrappers, near-zero payoff" (audit
  13 #338 caveat). The minimal smoke coverage flips the
  audit-log status from untested to minimally-covered
  without changing the underlying near-zero-payoff
  assessment.

### Tests
- Total: 719 (was 714, +5). Next close-out batches:
  CardStack-dismissal-callback documented-skip;
  briefing/memory refresh; 0.5.0 bump.

## [0.4.49] - 2026-05-24

### Added (test coverage)
- `tests/web/components/screens/Room.desktop.test.tsx`
  -- 15 new tests covering Room's desktop layout (the
  0.4.45 #338 caveat). Companion to Room.test.tsx
  (mobile, 0.4.44); same heavy-children-stub harness
  with `matchMedia` stubbed TRUE to take the desktop
  branch. **Close-out batch 1 of 5 for the 0.5.0
  release.**

  Desktop layout is structurally different from
  mobile: top bar with room name + UserPillRow +
  share/filter buttons; left sidebar with INLINE
  match cards (no separate MatchesList component on
  desktop -- the sidebar IS the matches list);
  center swipe stage; FilterPanel ALWAYS rendered
  inside a drawer wrapper, visibility driven by CSS
  class on the wrapper rather than conditional
  rendering.

  Covered surface:
  - **Top bar**: room name from `displayName` when
    present (falls back to `name`); `{N} swiping`
    count from `users.length`; filter + share
    buttons render.
  - **Matches sidebar**: empty placeholder copy
    ("Movies two or more of you love will land
    here."); match count in sidebar header; one
    match card per match sorted by descending
    `matchedAt`; match card click opens
    `window.open(plexUrl, '_blank')` with the local
    Plex URL when `plexServerId` is set AND
    `useLocalPlexReachable` returns true; match card
    click does nothing when no `plexServerId` is
    configured (the `webUrl && window.open(...)`
    short-circuit).
  - **Filter drawer**: FilterPanel always rendered
    with `isDrawer=true`; `isOpen` reflects
    `filterPanelOpen` state and flips when the
    filter button is clicked; FilterPanel.onApply
    dispatches `applyFilters`.
  - **Users popup + center stage**: UserPillRow
    click opens UsersPopup; close hides it;
    UsersPopup.onLeave dispatches `leaveRoom`.
    CardStack rendered in the swipe stage with
    `room.media` cards. MatchMoment renders in the
    swipe stage when a fresh match arrives
    post-mount.

### Tests
- Total: 714 (was 699, +15). Closes the 0.4.45 #338
  desktop-layout caveat. Next close-out batches:
  handlers/health + serve_static smoke tests; then
  CardStack-dismissal-callback documented-skip;
  then briefing/memory refresh; then 0.5.0 bump.

## [0.4.48] - 2026-05-24

### Fixed (audit 13 #299 -- cross-library filter dedup bug)

Multi-library Plex deploys lost items from non-canonical
libraries when filtering. **Closes the last deferred
audit item.**

**The bug**: a Plex server with multiple movie libraries
assigns per-library keys for filter values. So "Action"
in Movies might be `key=15` and "Action" in Family Movies
might be `key=23`. The provider's dedup loop (added
pre-#299) keeps the FIRST key per title, so the UI sees
"Action" once -- but when the user picks it, the apply
query carries only the canonical key (15), which matches
Movies but silently drops Family Movies's Action items
(key 23). Single-library deploys never hit this.

**The fix (Option A from the design conversation)**:
server-side expansion via a per-provider lookup, populated
alongside the dedup, consumed at query-build time. Zero
wire-format changes -- `types/reely.ts` untouched, UI
unchanged, FilterPanel + createStore + reducer tests
survive unchanged.

- **`internal/app/reely/providers/plex.ts`**:
  - Added `valueExpansion: Map<filterKey, Map<canonicalKey,
    string[]>>` at closure scope inside `createProvider`.
  - `getFilterValues` now builds the expansion alongside
    the dedup-by-title map: each title's canonical key
    (first encountered) maps to the full list of
    per-library keys with that title.
  - Re-fetching `getFilterValues` overwrites the prior
    expansion so a Plex-side library add/remove
    eventually shows up. Staleness window matches the
    requestFilterValues cadence (the UI re-fetches
    values on each FilterPanel open transition).
  - New closure helper `expandFilterValues(filters?)`
    maps each Filter's `value[]` through the lookup; no
    lookup or unknown values pass through unchanged
    (one untouched value reaches Plex rather than
    zero).
  - `getMediaCached` calls `expandFilterValues(filters)`
    before `filtersToPlexQueryString`, so the Plex
    query carries `genre=15&genre=23` (repeated key =
    OR on Plex's side) instead of just `genre=15`.
  - Cache key in `getMediaCached` still uses the
    ORIGINAL filters (via `normalizeFilters` upstream),
    so cache hits key on the user's pick, not the
    expanded form.

### Added (test coverage)
- **`tests/providers/plex.test.ts`** -- 9 new tests for
  the Plex provider's filter pipeline. First direct
  test file for the provider (previous coverage was at
  the `internal/app/plex/{api,util}.ts` layer below).
  Mocks `PlexApi` at the class boundary (returning a
  shared `mockApi` object from the constructor) so the
  test asserts against the URLSearchParams the provider
  hands to `api.getLibraryItems` -- the actual
  wire-format effect, not internal closure state.

  Covered:
  - Dedup by title (pre-#299 behavior unchanged): keeps
    first per-library key as canonical.
  - Empty api response -> empty values array.
  - `'library'` key special case -- returns the library
    list directly, doesn't go through dedup or call
    `api.getFilterValues`.
  - **Cross-library expansion** (audit #299): after
    `getFilterValues` populates the lookup, `getMedia`
    expands the canonical key into ALL per-library keys
    on the query (`params.getAll('genre') = ['15', '23']`
    for the Action-with-two-equivalents case).
  - Multiple selected values each get expanded
    independently (Action + Comedy with two equivalents
    each -> 4 query entries).
  - No-lookup pass-through: filters whose key was never
    fetched send the original value untouched.
  - Unknown-value pass-through: a value not in the
    lookup (stale or unseen) passes untouched.
  - Single-library deploys: canonical key expands to
    itself, no behavior change.
  - Re-fetching `getFilterValues` overwrites the prior
    expansion (Plex-side change eventually visible).

### Tests
- Total: 699 (was 690, +9). **Audit 13 #299 closed.**
  Audit log updated to mark this as DONE in 0.4.48.
  All deferred audit items from cycle 3 now closed
  (#321 in 0.4.47, #328 in 0.4.46, #299 here).

## [0.4.47] - 2026-05-24

### Changed (audit 13 #321 -- FilterPanel split, Option B)

Extract `SearchControl` and `FieldPicker` from
`FilterPanel.tsx` into their own files under
`components/molecules/`. **Closes a long-deferred
audit item.**

Per the conversation pinned in the briefing
("Test harness patterns" + the audit log #321 entry):
the obvious "FilterRow + FieldPicker + SearchControl"
split would have required ~8 props on FilterRow,
which would have been uglier than the inline row map.
Option B keeps FilterRow inline and extracts only the
two genuinely separable units:

- **`SearchControl`** (free-text tag input): already a
  discrete sub-component at the bottom of
  FilterPanel.tsx. 3 props (values, placeholder,
  onChange). Moved with its associated CSS to:
  - `web/app/src/components/molecules/SearchControl.tsx`
  - `web/app/src/components/molecules/SearchControl.module.css`
- **`FieldPicker`** (searchable list of available
  filter fields): 5 props (availableFields, search,
  onSearchChange, onSelect, onClose). The "Add filter"
  toggle button stays in FilterPanel (parent owns
  open/closed state), so FieldPicker just renders the
  open picker UI. Moved with its associated CSS to:
  - `web/app/src/components/molecules/FieldPicker.tsx`
  - `web/app/src/components/molecules/FieldPicker.module.css`

**FilterRow stayed inline.** The 8-prop interface
(filter + index + filters + filterValues + expanded +
onToggleExpand + onUpdate + onRemove) plus the variant
rendering across field types would have made it harder
to read as a separate file than as the inline row.
Documented in the source + audit log entry.

Source semantics unchanged across the move -- this is
a pure organizational refactor.

- **`web/app/src/components/organisms/FilterPanel.tsx`**:
  533 -> ~370 lines. Removed inline SearchControl + the
  picker-card JSX block. Imports the two new molecules.
  Picker JSX block (~50 lines) collapsed to a 7-line
  `<FieldPicker ... />`.
- **`web/app/src/components/organisms/FilterPanel.module.css`**:
  683 -> ~470 lines. Removed the .searchControl /
  .searchRow / .searchInput / .applyBtn / .searchTags
  / .searchTag / .searchTagRemove cluster (moved to
  SearchControl.module.css). Removed the .pickerCard
  / .pickerSearchRow / .pickerSearch / .pickerCancel /
  .pickerList / .pickerEmpty / .pickerItem /
  .pickerItemIcon / .pickerItemMeta / .pickerItemTitle
  / .pickerItemType / .pickerItemPlus cluster (moved
  to FieldPicker.module.css). Kept .addBtn
  (FilterPanel-only; the "Add filter" toggle).

### Added (test coverage)
- **`tests/web/components/molecules/SearchControl.test.tsx`**
  (+11 tests): renders the input with placeholder;
  Apply disabled when empty; enabled with non-whitespace
  input; onChange fires with trimmed value on Apply
  click; Enter key matches Apply behavior;
  duplicate-after-trim does NOT add; input clears
  after submit; whitespace-only doesn't submit (button
  disabled + Enter no-ops); tag list renders only when
  values non-empty; per-tag remove button fires
  onChange with that value filtered out.
- **`tests/web/components/molecules/FieldPicker.test.tsx`**
  (+8 tests): renders search input + Cancel button;
  reflects search prop as input value; onSearchChange
  fires on input; Cancel fires onClose; one button per
  available field with title + type rendered; onSelect
  fires with the field's key on click; "No more
  fields." empty state when availableFields is empty;
  first letter of title in the picker-item icon span.

### Tests
- Total: 690 (was 671, +19). Audit 13 #321 closed.
  Audit log updated to mark this as DONE in 0.4.47.
  FilterPanel.test.tsx (0.4.45) survived the refactor
  unchanged -- its tests target the external contract
  surface that the split was designed to preserve.

### Won't-fix history
- **FilterRow extraction**: deliberately skipped. The
  8-prop interface plus variant rendering across field
  types (boolean buttons vs values pills vs
  SearchControl based on `fieldDef.type` and loaded
  values) makes the inline row map more readable than
  a dedicated FilterRow component would have been.
  Documented at the SearchControl-extraction comment
  in FilterPanel.tsx.

## [0.4.46] - 2026-05-23

### Changed (audit 13 #328 -- module-scope counters into state)

Move `toastCounter` + `mediaVersionCounter` from
module-scope `let`s in `web/app/src/store/reducer.ts`
to fields on `Store`. The reducer is now pure -- each
Store instance keeps its own counters, no
cross-instance leakage via the module. Closes a
long-deferred audit item.

The invariant (monotonic within a Store's lifetime,
never reset -- mediaVersion is used as React's `key`
on CardStack remount; a reset would collide with a
prior CardStack and React would reuse the stale one)
still holds; it just lives explicitly in state
instead of implicitly in the module.

- **`web/app/src/store/types.ts`**: added
  `toastCounter: number` + `mediaVersionCounter:
  number` to `Store`, with an INVARIANT docstring
  explaining the no-reset rule and the rationale
  inherited from the pre-#328 module-scope design
  (won't-fix history entry #160).
- **`web/app/src/store/reducer.ts`**:
  - Removed the module-scope `let toastCounter = 0`
    + `let mediaVersionCounter = 0` and their
    `nextToastId()` + `nextMediaVersion()` helpers.
  - New pure helper `mintToastId(counter)` returns
    `` `toast-${counter}-${random()}` `` -- same
    format as before, just stateless.
  - `initialState` includes `toastCounter: 0` +
    `mediaVersionCounter: 0`.
  - Threaded counter bumps through 8 cases:
    - `createRoom` / `joinRoom` / `joinOrCreateRoom`
      (one shared block): bumps
      `mediaVersionCounter` and uses the new value
      as `room.mediaVersion`.
    - `createRoomSuccess` / `joinRoomSuccess`:
      bumps `mediaVersionCounter` again so the
      join success gets a fresh React key distinct
      from the optimistic-room one.
    - `filterChangeApplied`: bumps
      `mediaVersionCounter` ALWAYS; bumps
      `toastCounter` ONLY on the other-user branch
      (self-apply doesn't surface a toast).
    - `filterChangeError`, `leaveRoomError`,
      `logoutError`, `requestFiltersError`: each
      bumps `toastCounter` and uses it for the
      toast id.

### Added (test coverage)
- **`tests/web/reducer.test.ts`** -- 9 new tests
  under the "reducer counters in state (audit 13
  #328)" describe block. Existing tests survived
  the refactor unchanged (they thread state through
  `joinCycle` composition; the counter rides along
  correctly). New coverage:
  - initialState has `toastCounter=0` +
    `mediaVersionCounter=0`
  - `joinRoom` + `joinRoomSuccess` each increment
    `mediaVersionCounter` (and `room.mediaVersion`
    matches the new counter value)
  - `filterChangeError` bumps `toastCounter` and
    the toast id contains the counter
    (`/^toast-1-/`)
  - `navigate` (no toast/mediaVersion) does NOT
    bump either counter
  - `filterChangeApplied` bumps
    mediaVersionCounter always but `toastCounter`
    only on other-user applies
  - A sequence of actions threads counters
    monotonically across the chain
  - Two independent Store sequences produce
    identical counter trajectories (proves no
    cross-Store leak -- this was impossible under
    the module-scope design)
  - Toast id format `^toast-{counter}-{random}$`
    pinned so a future refactor doesn't drop the
    random component without realizing

### Tests
- Total: 671 (was 662, +9). Audit 13 #328 closed.
  Audit log updated to mark this as DONE in 0.4.46.

## [0.4.45] - 2026-05-23

### Added (test coverage)
- `tests/web/components/organisms/FilterPanel.test.tsx`
  -- 20 new tests for the room-filter overlay (audit
  13 #338 web-layer batch). **Closes the #338
  web-layer line**: with FilterPanel covered, the
  audit's "web layer: 26 components / 4 screens"
  surface is fully tested (all 9 atoms + 2 molecules
  + 5 organisms + 4 screens + 1 layout wrapper +
  useSelector).

  Tests deliberately target the **external contract
  surface** that should survive any reasonable #321
  split (FilterRow / FieldPicker / SearchControl).
  Internal row / picker / SearchControl shape is
  NOT asserted -- once #321 lands those will live
  in dedicated component tests.

  Covered surface:
  - **Loading state**:
    `<Tr name="FILTERS_LOADING" />` renders the raw
    key when `createRoom.availableFilters` is
    undefined; the "{N} fields available" subline
    is omitted while loading.
  - **Header chrome (catalog loaded)**: "Filter the
    room" + "Build a shortlist" headings, "{N}
    fields available" count derived from
    `availableFilters.filters.length`, close button
    with `aria-label="Close"` firing `onClose`.
  - **Empty state**: "No filters yet. Tap below to
    add one." copy when draft is empty.
  - **Apply button (default state)**: labeled
    "Apply filters"; disabled when draft is empty;
    footer hint shows "ADD AT LEAST ONE FILTER TO
    APPLY".
  - **Apply with populated draft** (seeded from
    `room.activeFilters` at mount): button
    enabled; clicking fires
    `onApply(applicableFilters)` AND `onClose`;
    footer hint flips to "APPLIES FOR EVERYONE IN
    THE ROOM".
  - **Clear mode**: when `room.activeFilters` is
    non-empty but the draft has no APPLICABLE
    filters (e.g. value=[]), button flips to
    "Clear filters" + enabled; clicking fires
    `onApply([])` AND `onClose`; footer hint shows
    "CLEARS ALL FILTERS FOR EVERYONE IN THE ROOM".
    Without this branch, applied filters could
    never be removed from the UI.
  - **isDrawer layout switch**: `isDrawer={true}`
    uses `drawerContent` class; default uses
    `overlay` class.
  - **Re-open draft re-sync**: while the panel is
    open, the user's in-progress edits stay put
    even if `room.activeFilters` changes
    server-side. On a CLOSED -> OPEN transition the
    draft re-syncs from `room.activeFilters`, so
    the panel doesn't reopen with stale-from-
    last-open edits. Verified via the `isOpen`
    prop toggle.

### Tests
- Total: 662 (was 642, +20). **Audit 13 #338
  web-layer line is fully covered**: all 9 atoms +
  2 molecules + 5 organisms + 4 screens + 1 layout
  wrapper + useSelector now have render tests under
  the jsdom + RTL harness from 0.4.34. Caveats
  documented in earlier batches still apply:
  CardStack's dismissal-callback fire path needs a
  Controller mock that vi.mock couldn't intercept
  (deferred; would need either deeper vitest
  config, factory-injection at the component
  boundary, or a Playwright harness); Room's
  desktop layout warrants its own pass;
  `handlers/health.ts` + `handlers/serve_static.ts`
  left untested deliberately (trivial wrappers,
  near-zero payoff). FilterPanel still has the
  deferred #321 split issue -- when that lands,
  this test file may need light revision but the
  external-contract assertions should mostly
  survive.

## [0.4.44] - 2026-05-23

### Added (test coverage)
- `tests/web/components/screens/Room.test.tsx` -- 16
  new tests for the swipe-screen container (audit 13
  #338 web-layer batch). Heavy-children stubs only --
  CardStack / FilterPanel / UsersPopup / MatchesList /
  MatchMoment / Card all replaced with sentinel
  components so the test focuses on Room's own
  orchestration. Mobile layout only -- matchMedia
  stubbed to return false for `(min-width: 900px)`;
  desktop layout warrants its own pass if/when the
  audit calls for it. Web-layer progress: 3 of 4
  heavy remaining files done; only FilterPanel
  remains (still gated on the deferred #321 split
  conversation).

  Covered surface:
  - **No-room early return**: `<ErrorMessage
    message="No Room!" />` when `room` is undefined
    in the store; none of the heavy children render.
  - **Mobile layout basics**: CardStack receives the
    `cards` from `room.media`; mobile match strip
    renders when matches present + the empty
    placeholder ("matches will appear here as you
    swipe") when not.
  - **Popup wiring**: filter button click opens
    FilterPanel sentinel; FilterPanel.onClose hides
    it; FilterPanel.onApply -> dispatches
    `applyFilters` with the payload. UserPillRow
    click opens UsersPopup sentinel; close hides it;
    UsersPopup.onLeave -> dispatches `leaveRoom`.
    Mobile match strip click opens MatchesList
    sentinel.
  - **`requestFilters` prefetch**: dispatched on
    mount when `createRoom.availableFilters` is
    absent; NOT dispatched when it's already
    present. The prefetch lets the
    `filterChangeApplied` toast resolve field titles
    even when the user hasn't opened the panel yet.
  - **Match-celebration queue** (audit 11 #178 +
    audit 12 #244): matches present at mount are
    treated as the join's `previousMatches` and do
    NOT pop a celebration; a fresh match appearing
    AFTER mount pops `MatchMoment` with
    `isBig=true` (first celebration of the
    session); after the first dismiss, subsequent
    matches in the queue flip to `isBig=false`
    (toast form). The `bigCelebrationShown` ref
    flips on first dismiss regardless of how many
    matches the user is queued through, so a
    2-match batch shows big then toast (not big
    then big).
  - **Share button with clipboard fallbacks**:
    `navigator.clipboard.writeText` called when
    available, "Copied!" state surfaced via the
    label flip; `window.prompt` fallback fires when
    BOTH `clipboard.writeText` AND
    `document.execCommand("copy")` fail
    (non-secure-context path -- reely's stated LAN
    deployment target uses plain http://).

### Tests
- Total: 642 (was 626, +16). Web-layer progress:
  3 of 4 heavy remaining files done (Login +
  CardStack + Room). Only **FilterPanel** remains
  -- still gated on the deferred #321 split
  decision the owner flagged earlier.

## [0.4.43] - 2026-05-23

### Added (test coverage)
- `tests/web/components/organisms/CardStack.test.tsx`
  -- 11 new tests for the swipe-deck organism
  (audit 13 #338 web-layer batch). Organism progress:
  4 of 5 (FilterPanel still ahead).

  Covered surface:
  - **Empty state**: heart + "That's everything."
    copy; `<Tr name="RATE_SECTION_EXHAUSTED_CARDS" />`
    falls back to rendering the raw key when no
    translations are loaded (Tr's `?? name` path);
    Pass + Like buttons omitted in empty state.
  - **Populated rendering**: Pass + Like buttons
    rendered; up to `INITIAL_COUNT` (5) cards mounted
    initially -- cards 6+ deferred until the reducer
    dispatches `add` as earlier cards get removed;
    fewer cards rendered cleanly when the input list
    is smaller.
  - **Connection-status gates**: Pass + Like buttons
    while disconnected do NOT fire `onCardDismissed`
    (rateItem early-returns before touching the
    controller); ArrowLeft + ArrowRight while
    disconnected do NOT fire (same gate inside the
    keydown handler); non-arrow keys (Space, Enter,
    letters) never fire even when connected.
  - **memo() invariant** (audit-documented INVARIANT
    in the source): the memo's `areEqual` returns
    true unconditionally so a prop change after mount
    does NOT add new cards to the stack -- the parent
    (Room) forces a full remount via
    `key={room.mediaVersion}` when the card set
    genuinely changes. Pin this so a future
    contributor who removes the memo (or changes
    areEqual) breaks the test loudly and has to
    think through the animation-safety consequences.

### Tests
- Total: 626 (was 615, +11). Web-layer progress: 2
  of 4 heavy remaining files now have tests (Login
  in 0.4.42, CardStack here; FilterPanel + Room
  still ahead -- noting the owner's earlier flag on
  FilterPanel / deferred #321 split).

  *Correction to 0.4.42's CHANGELOG note: that entry
  said "3 of 4 heavy remaining files done" which was
  wrong -- only Login (1 of 4) was complete at that
  point. After this batch, the accurate count is 2
  of 4 done (Login + CardStack), with FilterPanel +
  Room still ahead.*

### Notes
- **CardStack's dismissal callback fire path is NOT
  covered.** The `rateItem -> dispatch remove ->
  controller.start().then(onCardDismissed)`
  end-to-end flow requires intercepting
  `@react-spring/web`'s `Controller`, which
  `vi.mock` couldn't catch in this batch (the SUT's
  imports resolve through the web/app pnpm tree past
  where the mock factory runs). Three attempts
  failed during 0.4.43 -- adding the modules as
  root devDeps, aliasing them to web/app installs in
  `vitest.config.ts`, and
  `deps.optimizer.web.include` -- none caused the
  mock factory to fire. Driving the dismissal
  callback would need either (a) deeper vitest
  config work, (b) restructuring CardStack to inject
  the Controller factory as a prop / context so a
  test double can be substituted at the component
  boundary, or (c) moving to a real-browser harness
  (Playwright) where the actual animation can run.
  Documented in the test file's header comment.

## [0.4.42] - 2026-05-23

### Added (test coverage)
- `tests/web/components/screens/Login.test.tsx` -- 22
  new tests for the Login screen (audit 13 #338
  web-layer batch). Smallest of the four heavy
  remaining files; most contained. Uses the store-mock
  pattern from 0.4.36; sanitize utils run real via
  importActual (already covered by
  `tests/web/sanitize.test.ts`).

  Covered surface:
  - **Initial UI from mount-time inputs** (the audit
    13 #308 useState lazy-initializer reads): no
    stored userName -> input shown (autoFocus);
    stored userName -> chip shown; `?roomName=` in
    the URL seeds the room input via
    `URLSearchParams` / `location.search` (location
    overridden per test via
    `Object.defineProperty`); empty URL leaves the
    room input empty; headline + subline render.
  - **Server chip + error box (store-driven)**:
    server chip hidden when config has no
    `serverName`; rendered with name + ProviderIcon
    + status dot (via `data-status=`) when set;
    error box renders the message; falls back to
    "Something went wrong" when error has no message
    field.
  - **Submit + validation**: empty name at submit ->
    "Required" + edit mode + no dispatch; empty room
    -> "Required" + no dispatch; valid submit while
    not logged in -> dispatch `login` (and the
    deferred join NOT fired yet); valid submit while
    logged in under the SAME name -> dispatch
    `joinOrCreateRoom` directly (no re-login); valid
    submit while logged in but the chip was edited
    to a DIFFERENT name -> re-dispatch `login`
    (otherwise the join would land under the old
    server-side username -- rationale documented in
    the source).
  - **Deferred-join effect (audit 12 #216)**: after
    submit captures `pendingJoinRoom.current`,
    dispatches login; once `user` appears in the
    store on rerender (login-success), the effect
    fires `joinOrCreateRoom` with the captured room
    name. Pinned: the string|null ref instead of a
    boolean lets a user who keeps typing between
    submit and login-success ship the room name
    they CLICKED with, not whatever the input shows
    by the time user-set lands. Companion test:
    error arrives -> deferred slot cleared -> a
    later auto-set of `user` (e.g. WS reconnect
    populating the cached session) does NOT silently
    fire a stale join.
  - **CTA button states**: "start screening" by
    default; "joining…" when room exists but
    `!room.joined`; disabled when validation fails;
    disabled while joining.
  - **Chip <-> input transitions**: clicking the
    chip opens the name input; Escape in edit input
    restores the pre-edit name (via `preEditName`
    ref) and returns to chip view.

  Test-harness notes:
  - `Object.defineProperty(window, 'location', ...)`
    overrides `location.search` for the mount-time
    URL read; can't assign to `window.location`
    directly in jsdom.
  - State changes triggered by a useEffect on
    `user` are exercised by re-calling
    `withState({ user: { ... } })` THEN
    `rerender(...)` inside `act()`. Same pattern
    works for the deferred-join +
    error-clears-slot tests.
  - File-level `noNonNullAssertion` ignore: the
    test uses `closest('form')!` and
    `closest('button')!` on SUT-rendered structure;
    a missing ancestor would surface a TypeError
    that's no less actionable than a Vitest
    assertion.

### Tests
- Total: 615 (was 593, +22). Web-layer progress: 3
  of 4 heavy remaining files done (Login here;
  CardStack + FilterPanel + Room still ahead).

## [0.4.41] - 2026-05-23

### Added (test coverage)
- Four small targets covered in one batch (audit 13
  #338 web-layer batch). Picks off the trivial-screens
  + Layout + the long-deferred `useSelector` hook. The
  remaining heavy lifts (CardStack, FilterPanel,
  Login, Room) each warrant their own focused batch.

  - `tests/web/components/screens/Loading.test.tsx`
    (+3 tests) -- the full-viewport branded loader.
    Renders the "reely" wordmark; exposes
    `role=status` + `aria-label="Loading reely"`; the
    wordmark span is `aria-hidden` (decorative -- the
    status role owns the spoken label).
  - `tests/web/components/screens/Config.test.tsx`
    (+3 tests) -- the "not-set-up" notice shown when
    the server boots without a Plex provider. Renders
    the heading + body copy; sits inside Layout so
    the brand Logo wordmark is visible.
  - `tests/web/components/layout/Layout.test.tsx`
    (+5 tests) -- the thin wrapper used by every
    full-screen view. Renders children; renders the
    Logo by default; hides it when `hideLogo`; passes
    `className` through to the section; keeps the
    default `screenLayout` class even with no
    override.
  - `tests/web/store/useSelector.test.tsx` (+5 tests)
    -- the typed Pick wrapper around the Zustand
    store + `useShallow`. Tests use `renderHook` from
    RTL and a real Zustand store created in
    `beforeEach`; `createStore` is mocked so
    `useZustandStore` returns the test fixture
    instead of the production store factory's WS
    client. Covers: picks only the requested keys
    (and nothing else); updates when underlying
    state changes; **returns a reference-stable
    subset when only UNPICKED keys change** (the
    point of `useShallow` -- a `toasts` change
    doesn't re-fire the consumer that picked
    `['route', 'user']`); returns a new reference
    when a picked key changes.

- **devDependencies added (root)**: `zustand@^5.0.3`
  for typecheck resolution from root-level test
  files (the runtime alias in `vitest.config.ts`
  funnels zustand imports to web/app's install, but
  TypeScript needs the package visible from the test
  file's directory for type lookups).

### vitest.config.ts
- `resolve.alias` extended with `zustand` +
  `zustand/react` + `zustand/react/shallow` ->
  `web/app/node_modules/zustand/...` so the test
  toolchain uses a single Zustand instance (same
  reasoning as the React aliases added in 0.4.34 --
  two store instances would have separate subscriber
  sets and break `act()` updates).
- Helper renamed `webAppReact` -> `webAppDep` since
  it now handles non-React deps too.

### Tests
- Total: 593 (was 577, +16). Organism progress
  unchanged: 3 of 5. **Layout + 2 trivial screens +
  useSelector all done**. Remaining web-layer
  surface: CardStack (451, swipe deck with
  react-spring + @use-gesture/react), FilterPanel
  (533, has the deferred #321 split), Login (265),
  Room (572 -- the swipe-screen container).

## [0.4.40] - 2026-05-23

### Added (test coverage)
- `tests/web/components/organisms/MatchesList.test.tsx`
  -- 14 new tests for the shortlist overlay (audit 13
  #338 web-layer batch). Reuses the store + plexLinks
  mock pattern landed in 0.4.36 / 0.4.39. Organism
  progress: 3 of 5.

  Covered surface:
  - **Empty state**: "No matches yet." copy renders
    when `room.matches` is empty AND when `room` is
    undefined entirely (defensive); header still shows
    count "0" with the "matches" accent.
  - **Populated state**: header count from
    `matches.length`; rows sorted by descending
    `matchedAt` (newest first); each row's title +
    meta line (`year · duration · rating`); poster
    img with src/alt vs. title-as-placeholder when
    posterUrl is undefined.
  - **Animation delay cascade**: pin the `i * 40ms`
    formula -- each row's `animationDelay` is
    `'0ms'` / `'40ms'` / `'80ms'` / ... so a future
    refactor changing the multiplier breaks the test
    instead of the cascade-timing UX silently.
  - **Genre cap**: regardless of how many genres the
    media has, only the first 2 render. Selector
    note: `[class*="genrePill"]` would also match the
    `genrePills` wrapper (substring match), inflating
    the count by one -- the test uses
    `[class*="genrePills"] > span` to scope to inner
    pills only.
  - **Avatar cap**: regardless of how many users
    matched, only the first 3 avatars render.
  - **Plex link per row**: renders when
    `plexServerId` is set; omitted entirely when it
    isn't; routes to the local Plex web UI when
    `plexBaseUrl` is set AND
    `useLocalPlexReachable -> true` (verified via
    the host substring in href).
  - **Close**: button fires `onClose`.

### Tests
- Total: 577 (was 563, +14). Organism progress: 3
  of 5 (UsersPopup + MatchMoment + MatchesList
  done). Remaining organisms: CardStack (451, swipe
  deck), FilterPanel (533, has the deferred #321
  split). Plus `web/app/src/store/useSelector.ts`,
  4 screens, and the trivial Layout wrapper.

## [0.4.39] - 2026-05-23

### Added (test coverage)
- Two organism components covered: the smaller ones,
  the natural step up from molecules (audit 13 #338
  web-layer batch). Organism progress: 2 of 5.

  - `tests/web/components/organisms/UsersPopup.test.tsx`
    (+10 tests) -- the room-roster modal. Pure
    presentation + a couple of dismiss paths -- no
    store, no timers. Covers:
    - Title "In this room (N)" pulls the count from
      `users.length`.
    - One row per user with the user's UserPill +
      progress text (`Math.round(progress * 100)%`).
    - "Me first, then descending progress" sort (audit
      14 #333): current user always pinned to top
      regardless of own progress, others sorted by
      descending progress.
    - `isMe` forwarded only to the matching pill.
    - Close button fires `onClose`.
    - Backdrop click fires `onClose`; dialog click does
      NOT (stopPropagation on the dialog wrapper).
    - Leave button fires BOTH `onLeave` AND `onClose`
      (popup self-dismisses so the parent doesn't have
      to coordinate).
    - Escape key fires `onClose` (the `useEscape`
      hook, shared with FilterPanel + MatchMoment).

  - `tests/web/components/organisms/MatchMoment.test.tsx`
    (+13 tests) -- the match-celebration overlay
    (toast variant + big-celebration variant). Uses
    fake timers for the auto-dismiss test; stubs
    PlexLinks as a sentinel marker (already covered
    separately) to avoid re-establishing the store
    mock. Covers:
    - **Toast variant** (`isBig=false`): renders the
      "New match" label + media title + poster + a
      Dismiss button; omits the poster img when
      `posterUrl` is undefined; auto-dismisses after
      exactly 3000ms (not at 2999, fires at 3001);
      Dismiss button fires `onDismiss`; does NOT
      respond to Escape (the `useEscape` second arg is
      `isBig`, gating the keyboard binding to the big
      variant).
    - **Big variant** (`isBig=true`): renders the
      celebration overlay with headline + subline +
      poster + 20-piece confetti; 2-user subline "You
      both like this one."; N-user subline "N of you
      like this one." for 3+ matchers; one Avatar per
      matcher (counted via the avatarRow container's
      svg children); poster fallback to a
      title-as-placeholder div when no posterUrl;
      PlexLinks stub renders; "Keep swiping" fires
      `onDismiss`; overlay backdrop click fires
      `onDismiss`; does NOT auto-dismiss (the 3s
      timer is skipped when `isBig`); Escape fires
      `onDismiss` (the useEscape binding active here).

### Tests
- Total: 563 (was 540, +23). Organism progress: 2 of
  5 (UsersPopup + MatchMoment done). Remaining
  organisms: MatchesList (172), CardStack (451 --
  the swipe deck), FilterPanel (533 -- the largest,
  has the deferred #321 split). Plus
  `web/app/src/store/useSelector.ts`, 4 screens, and
  the trivial Layout wrapper.

## [0.4.38] - 2026-05-23

### Added (test coverage)
- Both molecules covered (audit 13 #338 web-layer
  batch). Molecule tier complete: 2 of 2 done.

  - `tests/web/components/molecules/UserPillRow.test.tsx`
    (+9 tests) -- the room user-pill row. Covers:
    - Renders all users at or under maxVisible
      (default 4).
    - Overflow badge "+N" appears when count exceeds
      maxVisible; absent when count equals it.
    - Current user pinned to the front so they're
      always inline (even in a crowded room where
      they'd otherwise land in overflow). Other users
      keep server order.
    - `isMe` prop forwarded only to the matching pill
      (asserted via the pillMe class on the matching
      UserPill, absent on the others).
    - Progress fraction multiplied by 100 before being
      passed to UserPill (the row uses 0..1, UserPill
      uses 0..100).
    - Clicking the row fires onClick.
    - aria-label exposes the user count for the
      "show all users" affordance.

  - `tests/web/components/molecules/Card.test.tsx`
    (+16 tests) -- the swipe-deck card + link-card
    variant. Mocks `isIOS` (the import-time const) via
    a get-accessor proxy and stubs `PlexLinks` as a
    sentinel marker (already covered separately in
    `tests/web/components/atoms/PlexLinks.test.tsx` --
    re-establishing the store mock here would
    duplicate coverage without adding signal).
    Covers:
    - **Default render**: poster img with src + alt;
      omitted entirely when posterUrl is undefined;
      title `Title (year)` for movie type; meta line
      `year · duration · ★ rating` with each segment
      conditionally included (duration omitted when 0;
      rating omitted when 0).
    - **Info toggle**: default button labeled
      "More info"; click flips to the more-info view
      (genres pills + description + PlexLinks sentinel
      visible, button relabeled "Show title"); second
      click flips back. `preventDefault` on the
      info-button click so the enclosing parent (e.g.
      CardStack swipe target) doesn't navigate. The
      more-info meta line includes the full
      four-segment chain (year + duration + rating +
      contentRating).
    - **href variant** (link card): renders as `<a>`
      with the href; `target="_blank"` on non-iOS,
      `target="_self"` on iOS (audit 13 #325 Safari
      new-tab quirk); info-toggle button is omitted on
      link cards; `rel="noopener noreferrer"`.

  Test-harness note worth pinning: a click that
  triggers React state updates needs
  `fireEvent.click(...)` (not `Element.click()`).
  RTL's fireEvent wraps the dispatch in `act()` and
  flushes React's update batching synchronously so
  subsequent `screen.getByText(...)` reads the
  post-update DOM. `Element.click()` dispatches a real
  synthetic click but React's state-update happens
  outside the test's awareness, so reads run against
  the pre-update DOM. (Came up here on Card's
  info-toggle tests.)

### Tests
- Total: 540 (was 515, +25). **Molecule tier
  complete**. Atoms (9 of 9) + molecules (2 of 2)
  done. Remaining web-layer surface for audit 13
  #338: `web/app/src/store/useSelector.ts` + organisms
  (5 files, ~1400 lines including the deferred-split
  FilterPanel) + screens (4 files) + layout (1 file,
  trivial wrapper).

## [0.4.37] - 2026-05-23

### Added (test coverage)
- `tests/web/components/atoms/Toast.test.tsx` -- 9 new
  tests for ToastList, the final atom in the atoms tier
  (audit 13 #338 web-layer batch). Closes atom
  coverage: all 9 atoms now have render tests under the
  jsdom + RTL harness landed in 0.4.34.

  Covered surface:
  - **Renders the list**: each toast's message lands in
    an `<li>`; empty / undefined `toasts` renders an
    empty `<ul>` cleanly.
  - **Appearance class** (`Success` / `Failure` /
    default): each toast gets
    `styles[`toast${appearance ?? ''}`]`, verified via
    the class attribute.
  - **Auto-dismiss timer**: `removeToast(toast)` fires
    once after exactly `showTimeMs` ms; not at 499/500
    boundary, fires at 501.
  - **Sticky toast** (no `showTimeMs`): never
    auto-removed even after 60s of fake-time advancing.
  - **Audit 10 #135 -- external-removal cleanup**: a
    toast removed externally (re-render with empty
    `toasts`) cancels its pending timer so the late
    setTimeout can't fire on an already-removed toast.
    Verified by removing before timeout, advancing past
    the original timeout, asserting `removeToast` was
    never called.
  - **No-restart-on-rerender**: re-rendering the same
    toast partway through its countdown does NOT spawn
    a fresh timer (`if (getTimers().has(toast.id))
    return;` short-circuit). Verified by re-rendering
    at 600ms into a 1000ms toast and asserting
    `removeToast` fires EXACTLY ONCE at the original
    1000ms mark.
  - **Unmount cleanup**: every pending timer is cleared
    on unmount, so a `setTimeout` scheduled during the
    component's life can't fire after unmount and call
    `removeToast` on a parent that no longer renders.
  - **Independent per-toast timers**: a 300ms and 700ms
    toast fire `removeToast(a)` at 301 and
    `removeToast(b)` at 701, in order.

  The audit 13 #310 lazy-ref pattern (timersRef.current
  starts null and is only materialized on first access)
  isn't directly asserted -- it's an internal
  allocation optimization not observable through the
  public surface. The behavioral tests above exercise
  the path it supports.

### Tests
- Total: 515 (was 506, +9). **Atom coverage tier
  complete: all 9 atoms covered** (Logo + ErrorMessage
  + CloseIcon + ProviderIcon + UserPill + Avatar + Tr
  + PlexLinks + Toast). Remaining web-layer surface
  for audit 13 #338: `web/app/src/store/useSelector.ts`,
  molecules, and screens.

## [0.4.36] - 2026-05-23

### Added (test coverage)
- Two more atoms covered, introducing the Zustand store
  mocking pattern for components (audit 13 #338 web-layer
  batch). Both atoms use `useStore(['...'])` from the
  Zustand store entry; the pattern lifts a `useStoreMock`
  via `vi.hoisted`, mocks the whole `'../../store'`
  module to return that mock, and lets per-test setup
  control the store contents.

  - `tests/web/components/atoms/Tr.test.tsx` (+7 tests)
    -- renders translations from the mocked store.
    Covers happy-path translation lookup; fallback to the
    name itself when the translation is missing
    (`{translation ?? name}`); `${key}` interpolation
    from context; the `?? full` fallback that keeps a
    `${name}` placeholder visible when the context key
    is missing (instead of the literal string
    "undefined"); the function-replacer form's opt-out
    of `String.replace`'s $& back-reference
    interpretation (a translation containing "$&" must
    not re-expand); dotted-path `${user.name}`
    placeholders looked up flat in context (matches the
    server-side template regex but the frontend doesn't
    walk nested objects); raw translation rendered
    untouched when no context is provided. File-level
    biome ignores on `noTemplateCurlyInString` (the
    `${...}` strings ARE the test fixtures, not
    unintended template literals) and `noExplicitAny`
    (TranslationKey union not worth threading through
    every render).
  - `tests/web/components/atoms/PlexLinks.test.tsx`
    (+8 tests) -- the "Open in Plex" link component.
    Mocks the store (config slice), `useLocalPlexReachable`
    hook, and the `isIOS` platform flag via a
    get-accessor proxy (the const is computed at import
    time so a `vi.stubGlobal('navigator', ...)`
    after-the-fact wouldn't take effect).
    `buildPlexLinks` is the real implementation via
    `importActual` (already covered by
    `tests/web/plexLinks.test.ts`). Tests:
    - renders nothing when serverId is undefined (config
      not yet received)
    - links to app.plex.tv when no plexBaseUrl
    - routes to the local Plex web UI when plexBaseUrl
      is set AND `useLocalPlexReachable -> true`
    - falls back to app.plex.tv when localReachable is
      false even with plexBaseUrl set
    - `target="_self"` on iOS (audit 13 #325 Safari
      new-tab quirk: `target="_blank"` opens a blank
      tab that never loads)
    - `target="_blank"` on non-iOS
    - clicks do NOT bubble to a parent overlay (the
      wrapper div's `stopPropagation()` handler prevents
      MatchMoment's overlay-onClick dismiss from firing
      when the user clicks the "Open in Plex" link)
    - `rel="noopener noreferrer"` on the external link

### Tests
- Total: 506 (was 491, +15). Atom coverage: 7 of 9 done
  (Logo + ErrorMessage + CloseIcon + ProviderIcon +
  UserPill + Avatar + Tr + PlexLinks). Only Toast remains
  for the atoms tier (scoped for the next batch with
  fake timers).

## [0.4.35] - 2026-05-23

### Added (test coverage)
- Four more atom components covered using the jsdom +
  @testing-library/react harness landed in 0.4.34 (audit
  13 #338 web-layer batch). Each atom is the minimum
  render-and-assert form -- no store mocking, no timer
  effects -- so this batch hardens the predictable
  surface before tackling Tr / PlexLinks (store hook
  deps) and Toast (timer effects) in follow-up batches.

  - `tests/web/components/atoms/ErrorMessage.test.tsx`
    (+2 tests) -- renders the message in a `<p>`; empty
    string renders cleanly.
  - `tests/web/components/atoms/CloseIcon.test.tsx`
    (+5 tests) -- defaults (size 14, strokeWidth 2),
    custom size, custom strokeWidth (the 2.5 tag-chip
    variant), className passthrough, aria-hidden
    (decorative -- surrounding button owns the label).
  - `tests/web/components/atoms/ProviderIcon.test.tsx`
    (+5 tests) -- Plex branch (two chevron paths in a
    black circle); size prop; future-Emby/JF placeholder
    branch (amber circle with the type's first letter
    uppercased); uppercase coverage for a sample type;
    aria-hidden.
  - `tests/web/components/atoms/UserPill.test.tsx`
    (+8 tests) -- userName renders; title attr carries
    the full untruncated name; truncation at
    TRUNCATE_AT - 1 chars + ellipsis kicks in over the
    cap; exactly-14-char names don't truncate; --hue
    and --progress CSS vars injected on the style attr
    (locked-in hue value 29 for 'alice' matches
    userHue.test.ts); progress clamped to [0, 100]
    (over-100 -> 100, negative -> 0); progress defaults
    to 0; isMe modifier class only when isMe is true.
  - `tests/web/components/atoms/Avatar.test.tsx`
    (+7 tests) -- letter fallback (first char
    uppercased) when no avatarUrl; pins the SCAFFOLDING
    avatarUrl branch (renders `<image>` AND omits the
    letter) even though Plex doesn't supply per-user
    avatars today, so a future audit doesn't strip the
    Emby/JF branch; progress ring renders only when
    progress > 0 (circle count check); --hue +
    --progress CSS vars on the SVG style; useId
    per-render gives each Avatar a unique mask id (the
    same audit-12 #195-class pattern Logo's gradient id
    uses -- pre-fix Date.now() collided when two Avatars
    rendered in the same millisecond); aria-hidden.

### Tests
- Total: 491 (was 464, +27). Atom coverage progress: 5
  of 9 atoms covered (Logo in 0.4.34; ErrorMessage +
  CloseIcon + ProviderIcon + UserPill + Avatar here).
  Remaining atoms: Tr (uses `useStore` for translations),
  PlexLinks (uses `useStore` for config + the
  `useLocalPlexReachable` hook), Toast (timer effects
  -- audit 10 #135 cleanup + audit 13 #310 lazy ref).
  These three are scoped for the next two batches: a
  Tr + PlexLinks pair (introduces the Zustand store
  mocking pattern for components), then Toast standalone
  (fake timers).

## [0.4.34] - 2026-05-23

### Added (test infrastructure + first React render tests)

Adopts jsdom + @testing-library/react for the web layer so
audit 13 #338 can extend to components and screens.
Previously web tests either tested pure logic with stubbed
DOM globals (sanitize, plexLinks, userHue) or mocked the WS
client / Zustand store (createStore, reelyClient). Render
tests for React components need a real DOM, React's
reconciler, and the JSX runtime -- this batch wires that up
and pins it with a first smoke test.

- **devDependencies added (root)**:
  - `jsdom` -- DOM env for the React renderer.
  - `@testing-library/react` + `@testing-library/dom` +
    `@testing-library/jest-dom` -- RTL render + assertion
    utilities.
  - `@vitejs/plugin-react` -- automatic JSX runtime +
    React-aware Vite transform (matches what web/app's
    prod build uses).
  - `react` + `react-dom` + `@types/react` +
    `@types/react-dom` at the root so root-level test files
    can resolve the React types; runtime imports are
    funneled via vitest alias (below) to web/app's single
    React install so no two-React-instance hook-call errors.

- **vitest.config.ts changes**:
  - `plugins: [react()]` for the JSX transform.
  - `resolve.alias` for `react` / `react-dom` /
    `react/jsx-runtime` / `react/jsx-dev-runtime` /
    `react-dom/client` -- all point at
    `web/app/node_modules/...` so even though the test
    toolchain deps are at root, the actual React instance
    hooks fire against matches web/app's. Two React
    instances would land on the classic "Invalid hook call"
    / cross-instance hook state error.
  - `include: ['tests/**/*.test.{ts,tsx}']` -- `.tsx`
    added so React tests under `tests/web/components/` are
    picked up.
  - Default environment stays `node` for the existing suite
    (server tests + pure-logic web tests). Component tests
    opt into jsdom per file via the
    `// @vitest-environment jsdom` directive -- per-file
    override keeps the rest of the suite on the faster
    node env.

- **`tests/web/components/atoms/Logo.test.tsx`** (NEW, 6
  tests) -- first React render test under the new harness.
  Pins three things:
  1. The jsdom override works via the per-file directive.
  2. CSS modules import cleanly under vitest's default
     transform (CSS files become proxy objects --
     `styles.root` becomes the string `"root"` -- no extra
     config required).
  3. React 18's `useId` works in the jsdom environment.

  Logo was the smoke-test target because it exercises
  useId (the audit 12 #195 gradient-id collision fix),
  React.memo (audit 14 #334), conditional render of the
  wordmark, and prop variations (size, withWord). The
  audit 12 #195 fix in particular is now pinned by a test
  that renders two Logos and asserts their
  `<linearGradient>` ids differ.

### Tests
- Total: 464 (was 458, +6). Audit 13 #338 web-layer line
  is now unblocked. The remaining surface (9 more atoms /
  the molecules + screens + useSelector) will be batched
  as time allows.

## [0.4.33] - 2026-05-23

### Added (test coverage)
- `tests/app/app.test.ts` -- 18 new tests for
  `internal/app/reely/app.ts`, the server bootstrap.
  This was the only large server-side gap left in
  audit 13 #338. Covers startup orchestration without
  actually opening sockets or hitting the disk: every
  external dep (Node http/https, fs/promises, ws, Plex
  provider, roomStore, logger, handlers/api) is mocked.

  Covered surface:
  - **Provider config branches**: zero servers boots
    silently (no warn, no createProvider call); 2+
    servers logs the "supports one" warn AND only the
    first becomes a provider (audit 12 #233/#239/#273
    -- the `servers` array stays for the 1.0
    multi-PROVIDER extension but multi-server is not a
    supported config); non-plex `server.type` rejects
    via the runtime guard and resolves `statusCode` to
    1 with the error logged; provider
    `isAvailable() -> false` rejects `statusCode` with
    `ProviderUnavailableError` so `main.ts` can log
    that case specifically.
  - **TLS read order** (audit 13 #293): TLS cert/key
    are read at the TOP of the IIFE so a bad path
    fails fast BEFORE express setup + provider probes
    + `cleanupExpiredRooms`. Tests verify the
    early-exit ordering: a failed readFile resolves
    `statusCode` to 1 AND `cleanupExpiredRooms` is
    never called. Conversely, when TLS isn't
    configured, `cleanupExpiredRooms(ROOM_TTL_MS)`
    runs as part of normal startup.
  - **Bind-all-interfaces warn**: bound to `'0.0.0.0'`
    / `'::'` / `''` without `basicAuth` -> warn logged
    ("Bound to..."); same hostnames WITH `basicAuth`
    set -> NO warn; specific (`'127.0.0.1'`) hostnames
    -> NO warn regardless of auth. Pins the
    all-interfaces detection so an operator without
    auth doesn't quietly expose room creation to the
    network.
  - **HTTP vs HTTPS server selection**: no TLS ->
    `createServer` from `node:http`; with TLS ->
    `createServer` from `node:https` AND the pre-read
    cert + key bundle is passed through (verified by
    inspecting the createHttpsServer call args),
    proving the bundle isn't re-read inside the
    createHttpsServer arm.
  - **Shutdown via abort signal**: aborting the signal
    resolves `statusCode` to undefined,
    `flushPendingSaves` is called once,
    `httpServer.close` is called once,
    `closeAllConnections` is called once (so lingering
    plain-HTTP sockets don't hold the close callback
    hostage). The `shuttingDown` idempotency guard is
    smoke-checked via the single-call counts after one
    abort -- the guard exists for defensive re-entry
    from the listener even though AbortController
    itself only dispatches once.
  - **WS upgrade wiring**: `createWsUpgradeHandler` is
    called once and its result is attached to the HTTP
    server's `'upgrade'` event (verified via
    `EventEmitter#listenerCount`).
  - **Generic startup error**: a `cleanupExpiredRooms`
    rejection is caught by the IIFE's outer catch and
    surfaces as `statusCode` -> 1 with the
    "Application startup error" prefix.

  Test-harness notes worth pinning:
  - `vi.hoisted` lifts only the `vi.fn()` mock handles;
    fake HTTP server instances (which need
    `EventEmitter` at construction) are built in
    `beforeEach`. The hoisted factory runs BEFORE
    imports resolve, so anything touching imported
    symbols has to live outside it.
  - `signal.addEventListener('abort', ...)` is
    registered LATE in the IIFE (after express setup
    + listen + interval creation + shutdown
    definition). A single setImmediate await isn't
    enough -- a `waitForAbortListener` helper waits
    through 50 setImmediate cycles before firing the
    abort. AbortController only dispatches to
    listeners present at abort time;
    addEventListener-after-the-fact does NOT fire,
    so the order matters.
  - Mocked `node:fs/promises` uses `importActual` to
    preserve mkdtemp/chmod/rm for other test files
    (e.g. load_yaml.test.ts) -- only readFile is
    overridden by the per-test mock.

### Tests
- Total: 458 (was 440, +18). Closes the largest
  remaining audit 13 #338 server-side gap. Remaining
  surface: `web/app/src/store/useSelector.ts` + web
  components / screens (pending the render-testing
  strategy decision -- jsdom + @testing-library/react
  vs defer to 1.0).

## [0.4.32] - 2026-05-23

### Added (test coverage)
- Config loaders as direct unit tests (audit 13 #338) --
  three new test files covering the three config-loader
  modules that until now only had transitive coverage
  through `tests/config/loadConfig.test.ts`:
  - `tests/config/defaults.test.ts` (+7 tests) --
    `applyDefaults`: empty input -> full defaults, partial
    input overrides individual keys, nested
    `defaultServerConfig` (`type: 'plex'`) merged into
    EACH `servers[]` item, explicit `server.type` wins
    over default, `servers: []` stays empty, non-array
    `servers` doesn't crash the `Array.isArray` guard,
    and the function is non-mutating.
  - `tests/config/load_env.test.ts` (+30 tests) --
    `loadFromEnv`. Empty env -> undefined; scalar reads
    (HOST / PORT / LOG_LEVEL / ROOT_PATH); PORT
    non-numeric throws (with audit 12 #236
    JSON.stringify-quoting the offending value to keep
    hostile strings out of raw log output); EnvBool
    table (true / 1 / yes / on / TRUE / false / 0 / no /
    off / FALSE) + invalid-value rejection (no silent
    default coercion); EnvList comma-split + trim +
    empty-segment drop; PLEX_URL scheme enforcement
    (audit 12 #207) -- scheme-less throws, http:// and
    https:// both accepted; partial-bundle gates (audit
    12 #198) -- server / basicAuth / tlsConfig each
    emit only when BOTH halves of their required pair
    are set, so a half-bundle can't overwrite a
    YAML-configured partner; docker secrets take
    precedence over their env-var counterparts for both
    plex_token and auth_pass.
  - `tests/config/load_yaml.test.ts` (+11 tests) --
    `loadFromYaml`. Happy-path parse, empty-object
    parse, ENOENT -> typed `ConfigFileNotFoundError`,
    EACCES propagates as-is (not wrapped), non-object
    scalar root -> `isRecord` rejection, array root
    note (intentionally NOT rejected -- isRecord's
    `typeof === 'object' && !== null` accepts arrays;
    downstream validator catches), audit 12 #235
    JSON_SCHEMA gating -- `yes` / `on` stay as strings
    instead of YAML 1.1 booleans, literal `true` /
    `false` still parsed as booleans.

  Real-tempdir tests for load_yaml (mkdtemp + writeFile
  + chmod + rm) since js-yaml is the actual parser
  whose schema gating is under test; mocking fs would
  defeat the point. EACCES test skips under root (since
  root reads everything regardless of mode). vi.hoisted
  used for the load_secrets mock in load_env (vi.mock
  hoists above imports; a plain const declaration would
  be in TDZ when the mock factory runs -- same root
  cause as the loggerMockFactory closure-form pattern
  from 0.4.24).

### Tests
- Total: 440 (was 392, +48). Continues audit 13 #338
  per-module coverage uplift. Remaining surface:
  `app.ts` server bootstrap (only large server-side
  gap left), `useSelector` + web components + screens
  (pending render-testing strategy decision).

## [0.4.31] - 2026-05-23

### Added (test coverage)
- Small-utils coverage bundle (audit 13 #338) -- five new
  test files covering the cluster of small untested
  utilities that had been queued for a single batch:
  - `tests/util/assert.test.ts` (+8 tests) -- `ReelyError`
    + `ReelyUnknownError` + `assert()` + `isRecord()`.
    Covers the no-op truthy path, every standard falsy
    value throwing, custom `ErrorType` injection, and
    `isRecord`'s nullable / non-object rejections. Notes
    the `typeof === 'object'` loose acceptance of arrays
    (a known surprise vs strict POJO-only).
  - `tests/web/format.test.ts` (+5 tests) --
    `formatDuration` pinning the under-an-hour,
    hour-plus-minutes, round-to-minute, and
    boundary-rounding behaviors so a 91s clip continues to
    show "2M" instead of "1M".
  - `tests/web/platform.test.ts` (+4 tests) -- `isIOS`
    userAgent detection for iPhone, iPad, and desktop,
    plus the iPadOS-13+-as-MacIntel false-negative pinned
    as documented known behavior. Uses `vi.resetModules`
    per test since `isIOS` is a module-level const
    computed at import time.
  - `tests/web/poster.test.ts` (+4 tests) -- `posterSrc`
    rootPath prefixing under reverse-proxy mounts. Covers
    undefined input, no rootPath, rootPath configured, and
    the dataset-rootPath-undefined coalesce-to-empty edge.
  - `tests/web/userHue.test.ts` (+6 tests) -- stable
    per-username hue. Range check, determinism,
    case-insensitivity, hyphen-kept (audit 12 #265),
    whitespace+punctuation-stripped, empty-string -> 0,
    and locked-in hash values for `'alice'` (29) +
    `'bob'` (272) -- failure here means a mid-session
    recolor of every existing user (UX consultation owed
    before bumping the locked values).

  `web/app/src/store/useSelector.ts` is deliberately
  skipped in this batch: it's a thin React-hook wrapper
  around `useZustandStore(useShallow(...))` and properly
  testing it needs a render harness. Bundled into the
  web-components + screens decision (jsdom +
  @testing-library/react vs defer to 1.0).

### Tests
- Total: 392 (was 360, +32). Continues audit 13 #338
  per-module coverage uplift. Remaining surface: `app.ts`
  server bootstrap, `config/load_env.ts` / `load_yaml.ts`
  / `defaults.ts` as units (transitive coverage only via
  `loadConfig.test.ts`), `useSelector` + web components
  + screens (pending render-testing strategy decision).

## [0.4.30] - 2026-05-23

### Added (test coverage)
- `tests/web/createStoreEvents.test.ts` -- 20 new tests
  covering the reactive surface of
  `web/app/src/store/createStore.ts`: the `connected` /
  `disconnected` / `message` event-handler paths.
  Companion to 0.4.29's init + dispatch coverage; same
  mock harness, split for focus. Closes the createStore
  portion of audit 13 #338's coverage uplift.

  Covered surface:
  - **`connected` handler**: applies `connected`
    connection status; dispatches `setLocale` with
    `navigator.language`; dispatches `login` with the
    stored userName when not on the login route;
    navigates to `login` when no userName is stored;
    does NOT auto-login when the route IS `login`
    (audit 13 #301 stale-localStorage race guard);
    clears the loading-escape timer so a 5s tick can't
    re-flip route after a successful connection.
  - **`disconnected` handler**: applies `disconnected`
    connection status; does not arm the silent-rejoin
    path when the user wasn't in a room (verified
    indirectly via the loginSuccess paths).
  - **`message` handler -- loginSuccess paths** (audit
    13 #304):
    - Path 1 (in-room within the 10-minute reconnect
      window): silently rejoins via
      `client.joinOrCreateRoom` instead of letting the
      reducer's loginSuccess case clear room state.
      Verified that the room remains defined and route
      stays `room` after the reconnect cycle.
    - Path 1 (outside the window): falls through to
      the reducer, which clears the room and navigates
      to `login`. The silent rejoin must NOT fire
      (verified by clearing the mock between
      `enterRoom` setup and the late loginSuccess so
      the assertion measures only the handler's
      behavior).
    - Path 1 (rejoin rejects): surfaces a "Couldn't
      rejoin the room. Try again." toast so the user
      knows the silent retry failed.
    - Path 2 (not in-room + `pendingRoomJoin` set from
      URL): dispatches `joinOrCreateRoom` for the
      URL-supplied room.
    - Path 3 (no special case): falls through to the
      reducer's loginSuccess case; user is set, route
      goes to `login`, no `joinOrCreateRoom` call
      fires.
  - **userName persistence**: localStorage gets the
    userName only when it's a non-empty string
    (defensive against the old `userName!`
    non-null-assertion bug that would have stored the
    literal `"undefined"` and treated a future page
    load as a valid session for user "undefined").
  - **URL syncing**: `joinRoomSuccess` and
    `createRoomSuccess` write `?roomName=<name>` into
    the URL via `history.replaceState`;
    `leaveRoomSuccess` and `logoutSuccess` remove it.
  - **Silent-rejoin candidate dropped on explicit
    leave**: a later reconnect after `leaveRoomSuccess`
    does NOT silently rejoin the room the user
    deliberately left.

### Tests
- Total: 360 (was 340, +20). Closes the createStore
  portion of audit 13 #338. With handler-layer (poster
  + template, 0.4.27), WS-client (0.4.28), and
  createStore (0.4.29 + 0.4.30) now covered, the
  remaining #338 surface is `app.ts` server bootstrap,
  the three config loaders as units (currently
  transitive coverage only), small utils, and the web
  layer's components / screens.

## [0.4.29] - 2026-05-23

### Added (test coverage)
- `tests/web/createStore.test.ts` -- 20 new tests for
  `web/app/src/store/createStore.ts`, the Zustand
  store + WS event-wiring bridge between `ReelyClient`
  and the React tree. Previously untested per audit
  13 #338, despite carrying several patched paths
  (audit 12 #246, audit 13 #301/#302/#303, audit 14
  #365). This batch covers the init + dispatch
  surface; the connected / disconnected / message
  event-handler paths (three loginSuccess branches +
  URL syncing) are scoped for a follow-up batch.

  Covered surface:
  - **Initial state**: applies `connecting` connection
    status as the first state update; pre-navigates
    to `login` when the URL has `?roomName` but no
    `userName` is stored (skip the loading screen
    since the user can't auto-join without an
    identity); stays on `loading` when `?roomName` is
    set AND a `userName` exists (the auto-join
    happens on `loginSuccess`, not synchronously
    here).
  - **`dispatchToClient` routing**: one smoke test
    per ClientActions variant proving the action type
    maps to the right `ReelyClient` method (the
    switch's `default: never` enforces exhaustiveness
    at compile time, but a routing typo like
    `login -> client.logout` wouldn't fail typecheck).
    Covers `login`, `createRoom`, `joinRoom`,
    `joinOrCreateRoom`, `rate`, `setLocale`,
    `requestFilterValues`, `applyFilters`, plus the
    no-arg `logout` / `leaveRoom` / `requestFilters`
    trio. UI-only actions (`addToast`, `navigate`)
    are asserted NOT to forward to any WS method.
  - **`logout` dispatch clears `localStorage.userName`**
    so the next page load doesn't auto-login as the
    just-logged-out user.
  - **Dispatch promise-rejection toast** (audit 12
    #246): when a request method's promise rejects
    (e.g. `REQUEST_TIMEOUT_MS` in `api/reely.ts`, or
    a mid-wait socket close), an `addToast` action
    with the "The server isn't responding" message is
    applied. Plus a control test that fire-and-forget
    dispatches (`rate`) do NOT add a toast when they
    resolve cleanly.
  - **Loading-escape timer** (audit 13 #303): fires
    at 5s if still on `loading` route with no room
    and navigates to `login`; does NOT navigate if
    the route has already moved off `loading`; is
    cleared by signal abort (so a second
    `createStore` call cancels the first's timer
    instead of leaving it pending).
  - **AbortController teardown across HMR** (audit
    13 #302 / audit 14 #365): a second `createStore`
    call must abort the first's listeners. Verified
    by dispatching a `connected` event after the
    second call and asserting `setLocale` is called
    exactly once (one bind), not twice.

### Tests
- Total: 340 (was 320, +20). Continues audit 13
  #338 (per-module coverage uplift): the web layer's
  `store/createStore.ts` is now partially covered;
  the remaining event-handler paths (~12-15 more
  tests) are queued for the next batch alongside the
  same mock harness.

### Notes
- The `createStore` tests use a `ReelyClient` mock
  via `vi.mock(...)` that returns an `EventTarget`
  populated with `vi.fn()` methods (one per WS
  request method). A function expression -- not an
  arrow -- is required for the mock constructor since
  `createStore` does `new ReelyClient()`; biome's
  `useArrowFunction` rule is ignored on that line
  with a justification. Globals (`localStorage`,
  `location`, `history`, `navigator`, `document`)
  are stubbed in `beforeEach` and the module is
  re-imported per test via `vi.resetModules()` so
  the module-scope `client` / `useZustandStore` /
  `listenerController` singletons reset between
  tests.
- One test-design subtlety worth pinning here: when
  `createStore` is called a second time, it
  reassigns the exported `useZustandStore` let
  binding. The signal-abort test captures the FIRST
  store's handle before the re-call so it can
  observe whether the first's loading-escape timer
  actually got cleared, rather than measuring the
  second store's (independent) timer.

## [0.4.28] - 2026-05-22

### Added (test coverage)
- `tests/web/reelyClient.test.ts` -- 22 new tests for
  `web/app/src/api/reely.ts`, the browser-side WebSocket
  client. Until now this module was entirely untested
  despite carrying nontrivial reconnect, queueing, and
  request-correlation logic that prior audits patched
  multiple times. Covered surface:
  - **API_URL construction**: https -> wss protocol
    upgrade, rootPath joined into `/api/ws`, page query
    params stripped (so a `?debug=1` on the page can't
    end up in the WS handshake).
  - **`handleMessage` shape-guard** (audit 13 #311):
    null / non-object / non-string-`type` frames are
    dropped with a warn instead of going through the
    dispatcher; invalid JSON is caught without throwing.
    Valid frames dispatch under both their `type` event
    and the generic `message` event.
  - **`waitForConnected`**: resolves immediately when
    the socket is OPEN, waits on the client's own
    `connected` event otherwise, and still resolves
    across a reconnect swap (where the original socket
    is replaced by a fresh one).
  - **`waitForAnyMessage`** (audit 13 #312, #313 /
    audit 14 #311 cluster): resolves on the first
    matching type, rejects with a descriptive error
    when the socket closes mid-wait (so an in-flight
    `login` / `joinRoom` doesn't hang the UI for 15s),
    rejects after the 15s `REQUEST_TIMEOUT_MS` if no
    reply arrives, and uses the `match` predicate to
    correlate each `requestFilterValues` response to
    the caller that asked for that key (FilterPanel
    fires several at once).
  - **`sendMessage` + `pendingRates`**: forwards
    serialized messages when OPEN; queues `rate`
    messages only (other types are dropped with a
    warn) when not OPEN; caps the queue at
    `MAX_PENDING_RATES` (50) by shifting the oldest
    off; and re-queues the unsent tail at the head
    of `pendingRates` when the socket re-closes
    mid-flush (audit 13 #286) so swipe order is
    preserved across the next reconnect.
  - **Reconnect backoff**: a close schedules a
    reconnect; the base delay caps at 30s no matter
    how many failures accumulate (deterministic with
    `Math.random` pinned to 0 in the test).
  - **`flushAfterRejoinHandler` teardown** (audit 11
    #175 / audit 12 #213): two opens without an
    intervening join-success must not leave two flush
    listeners registered; the test queues one `rate`,
    cycles open -> close -> open + join, and asserts
    exactly one send, not two.

### Tests
- Total: 320 (was 298, +22). Continues audit 13 #338
  (per-module coverage uplift): the largest
  previously-untested module on the web layer is now
  covered, alongside the handler-layer coverage added
  in 0.4.27.

### Notes
- The WS client tests use a `MockWebSocket` double that
  records `send` calls and exposes `simulateOpen` /
  `simulateMessage` / `simulateClose` drivers so each
  test reads as a linear script of events. Globals
  (`WebSocket`, `location`, `document`) are stubbed in
  `beforeEach` and the module is re-imported per test
  via `vi.resetModules()` so the module-load IIFE
  that computes `API_URL` re-runs against each test's
  configured globals.

## [0.4.27] - 2026-05-22

### Added (test coverage)
- `tests/handlers/poster.test.ts` -- 20 new tests for the Plex
  thumbnail-proxy handler. Covers param validation
  (non-numeric providerIndex, out-of-bounds index, non-numeric
  metadataId/thumbId including path-traversal attempts),
  upstream forwarding (content-type / content-length headers,
  optional content-length), error paths (provider rejection
  -> 502, headersSent guard), and abort behavior
  (`res.on('close')` aborts the upstream fetch). First
  coverage for `handlers/poster.ts` (audit 13 #338).
- `tests/handlers/template.test.ts` -- 19 new tests for the
  HTML template handler. Covers basic substitution
  (`${version}` from getVersion, `${rootPath}` from config,
  translations from getTranslations), HTML escaping (XSS
  defense for `<`, `>`, `&`, `"`, `'`), rootPath resolution
  (x-forwarded-prefix > config > empty; whitespace strip;
  trailing-slash strip; allowlist + `..` exclusion gate),
  and missing-key / dotted-path handling (empty for missing,
  walks nested objects, returns empty when intermediate node
  isn't an object). First coverage for `handlers/template.ts`
  (audit 13 #338).

### Fixed
- **`rootPath` traversal gap surfaced by the new tests.** The
  audit-12 #224 fix added a charset allowlist for the
  x-forwarded-prefix path, with the stated goal of rejecting
  `..` / `<` / `>` etc. The allowlist character class
  `[A-Za-z0-9._\-/]` permits `.` (legit URL path char), so
  consecutive dots slipped through even though the audit
  comment specifically called them out -- `/../system`
  passed the regex. Added an explicit `candidate.includes('..')
  -> return ''` check before the allowlist test. Belt-and-
  suspenders: the regex still narrows to URL-safe ASCII; the
  `..` check is the specific traversal stopgap.

### Tests
- 298 total (was 259). +39 net (+20 poster, +19 template).
- All other 0.4.26 verifications still hold: typecheck clean,
  lint clean (0 errors, 0 warnings, 0 infos).

### Notes
- Partial progress on audit 13 #338 (per-module coverage
  uplift). The two non-trivial untested handlers
  (poster.ts, template.ts) now have unit coverage.
  `health.ts` (5 lines, trivial wrapper) and
  `serve_static.ts` (10 lines, trivial wrapper) remain
  untested; their test cost would be mostly ceremony for
  near-zero payoff. The wider coverage uplift (app.ts
  bootstrap, config/load_env.ts, config/load_yaml.ts,
  config/defaults.ts, web layer) continues in future
  batches.

## [0.4.26] - 2026-05-22

### Changed (lint warning cleanup)

Drove the Biome warning count from 77 + 8 infos (the baseline left
by 0.4.21 when the lint gate was first wired up) to **0 / 0 / 0**.
Fixes are split between real changes (~30) and inline biome-ignore
comments for deliberate patterns the rule doesn't recognize as
intentional (~30).

a11y improvements (real fixes):
- Every `<button>` in the app has an explicit `type="button"`
  (or `type="submit"` where it actually submits a form).
  ~25 buttons across FilterPanel, Room, CardStack, MatchMoment,
  MatchesList, Card. Default `submit` semantics on a button
  inside a form would silently submit; explicit `type` is the
  defensive default.
- Decorative SVGs now carry `aria-hidden="true"` so screen
  readers skip the icon and rely on the surrounding text
  label. ~15 SVGs across atoms (Avatar, Logo, ProviderIcon)
  and components.

Code quality (real fixes):
- `req.headers['origin'/'host'/'authorization']` ->
  `req.headers.origin/.host/.authorization` (useLiteralKeys).
- `'foo' + bar` string concat in `rateLimit.ts` -> template
  literal.
- `(translations ?? {})[name]` -> `translations?.[name]`
  (useOptionalChain in Tr.tsx).
- `item && item.controller.springs.x.idle` ->
  `item?.controller.springs.x.idle` (useOptionalChain in
  CardStack).
- `(document.body.dataset.rootPath ?? "") + "/api/ws"` ->
  template literal in api/reely.ts (useTemplate).
- Removed a redundant `<>...</>` fragment wrapper in
  CardStack (noUselessFragments).

Inline biome-ignore for deliberate patterns:
- `useExhaustiveDependencies` on several useEffects where
  the dep omission is intentional (mount-only prefetch,
  open-transition snap, dispatch-is-stable). Each ignore
  carries a rationale comment.
- `noStaticElementInteractions` + `useKeyWithClickEvents`
  on overlay backdrops + stopPropagation wrappers where
  the keyboard path is the Esc handler (`useEscape`) and
  adding tabIndex/onKeyDown to the backdrop would shift
  focus into an invisible element.
- `useSemanticElements` on the mobile match strip (a
  horizontally-scrollable `<div role="button">` whose
  scroll-snap CSS would be overridden by a real `<button>`).
- `noAutofocus` on the login name input (primary input on
  first boot) and the FilterPanel picker search (user-
  initiated focus shift).
- `noNonNullAssertion` on five sites with documented
  invariants (Map.has-then-Map.get, expect-then-access,
  closure-narrowed-by-outer-check, etc.).
- `noExplicitAny` on the react-spring v9 typedef-gap site
  (audit 14 #364, revisit on v10) + the
  Readable.fromWeb boundary cast in poster.ts + the
  helper-exposed captured headers in two test files.
- `noConsole` on the CLI version-print path (stdout for
  shell redirection, distinct from pino-routed
  application logging).
- `noTemplateCurlyInString` on two vite.config.ts
  string-replace calls that intentionally target literal
  `${rootPath}` / `${version}` placeholders in index.html.

### Tests
- 259 tests still pass. No new tests (lint cleanup; no new
  behavior).

### Backlog
- Audit-deferred items unchanged: #321 FilterPanel split,
  #328 reducer counters into state, #338 per-module
  coverage uplift, #299 filter cross-library dedupe.

## [0.4.25] - 2026-05-22

### Changed (efficiency + nit, audits 13 + 14 -- final batch)

Backend / Plex layer:
- `#296` `PlexApi.getLibraryItems` now pages through library
  sections via `X-Plex-Container-Start` / `X-Plex-Container-Size`
  (page size 1000). Single call returns the accumulated
  metadata. On a 4000-movie library that's 4 round-trips of
  ~500KB each vs the prior 1 round-trip of ~2MB; memory peak
  during the JSON parse + transform pass drops accordingly.
- `#330` Transient-error retry on every Plex GET. Two
  attempts total (one initial + one retry) with 300ms
  exponential backoff. Retries on 5xx responses + network-
  level failures (fetch throw); 4xx is a real error and
  isn't retried. Brief Plex 503s no longer poison the
  `cachePromise`-cached slot.
- `#329` `logger.debug` per Plex fetch now logs the
  pathname instead of `url.href`. Filter values + token
  redaction concerns shrink to just the path.
- `#353` `getFilters` `reduce(spread)` anti-pattern
  replaced with `Object.fromEntries(...map(...))`. O(N^2)
  -> O(N); small numbers today (~6 fields) but the shape
  shouldn't escape.
- `#359` + audit 14 same-site: `Room.userRated` reverse
  index (`Map<userName, Set<mediaId>>`) maintained
  incrementally in `storeRating`, rebuilt from `ratings`
  in `roomStore.loadRoom`. `getMediaForUser` now does O(1)
  lookup + O(media.size) filter instead of walking every
  rating tuple in the room per call. Real win on the join
  + applyFilters paths for ~4000-movie deploys.
- `#360` `rateLimit.ts` eviction loop split into two
  explicit passes: expired-bucket sweep, then oldest-bucket
  eviction. Same behavior, clearer intent.
- `#367` `handlers/api.ts:56` ws upgrade path extraction
  now uses `split('?')[0]` instead of constructing a full
  `URL` object purely to read `.pathname`. Fires per
  WS upgrade (including failed handshakes).

Frontend:
- `#331` `FilterPanel`: `usedKeys` + `availableFields` +
  `fieldsByKey` (new) wrapped in `useMemo`. The trio used
  to recompute per keystroke in the picker search; now
  only on actual dep change.
- `#332` `FilterPanel`: new `fieldsByKey: Map<key, field>`
  precomputed once via memo. The per-row `filters.filters
  .find()` calls (4 sites: addFilter, getSummary,
  getOpLabel, isFilterApplicable + the draft.map row
  loop) now do O(1) Map lookup.
- `#333` + audit 14 same-site: `UsersPopup` + `UserPillRow`
  sort wrapped in `useMemo`. Clone-and-sort no longer
  re-runs on every parent render.
- `#334` `React.memo` on `Avatar`, `UserPill`, `Logo`,
  `ProviderIcon`. All props are primitives / strings;
  shallow equality is correct. Combined with the
  `#333` sort fixes above, same-input parent re-renders
  now skip the atom rebuild entirely.
- `#336` `userHue.ts` regex hoisted to module scope. The
  prior inline `/[\p{Letter}-]/u.test(_)` constructed a
  fresh RegExp per character per call.

Build / deploy:
- `#335` Dockerfile runtime stage no longer runs
  `pnpm install --frozen-lockfile --prod`. Builder now ends
  with `pnpm --filter=reely deploy --prod /deploy`; runtime
  COPYs `/deploy/node_modules` + `/deploy/package.json`.
  Eliminates a network round-trip per image build and
  drops corepack/pnpm from the runtime image entirely.

### Tests
- 259 tests still pass. No new tests this batch (perf +
  doc work; existing tests cover behavior). The reverse-
  index logic is exercised by the existing `storeRating`
  tests + integration through `getMediaForUser` which
  multiple tests path through.

### Audit cycle 3 closeout
- Audits 13 + 14 are now fully addressed across 0.4.18 -
  0.4.25. Outstanding deferred items live in dedicated
  future batches: #321 (FilterPanel split), #328
  (reducer counters into state), #338 (per-module
  coverage uplift), #299 (filter cross-library dedupe).

## [0.4.24] - 2026-05-22

### Removed (dead code, audit 13)
- `#285` `SERVER_MESSAGE_TYPES` set in `createStore.ts`. The
  runtime allowlist duplicated the `dispatchToClient` switch;
  folded the 3 ClientAction-only types (`addToast`,
  `removeToast`, `navigate`) into the switch as no-op cases
  returning `undefined`, so the caller's existing
  `if (result instanceof Promise)` gate handles the "skip
  catch attach" path naturally. The `default: never` still
  enforces exhaustiveness at compile time.
- `#314` `internal/app/reely/util/env.ts` (one-line wrapper
  over `process.env[name]`). Two importers (`logger.ts`,
  `cmd/reely/main.ts`) inlined to `process.env.NAME`. File
  deleted.
- `#316` Dropped `export` from 13 unused-externally types in
  `plex/types/library_items.ts` (Operator, FilterType,
  Filter, Sort, ActiveDirection, Tag, Media, Part,
  AudioProfile, Container, VideoProfile, AudioCodec,
  VideoCodec, VideoFrameRate, ChapterSource, ViewGroup,
  ContentRating). Kept exported: LibraryItems, Meta,
  FieldType, Type, Field, LibraryItem (real consumers).
- `#318` `start` script in root `package.json` (Docker uses
  ENTRYPOINT, dev uses `serve`).
- `#319` `preview` script in `web/app/package.json` (never
  invoked).

### Fixed (correctness + types)
- `#300` + audit 14 `#357` `Operator.key` union in
  `library_items.ts` corrected. Removed `<<=` (never observed
  in Plex responses) and `!==` (TS-side typo -- Plex uses
  `!=`). New union: `"=" | "!=" | ">=" | "<=" | ">>=" | "<<"`.
  Comment block documents the actual operator vocabulary.

### Changed (test infra, audit 13)
- `#320` Migrated 10 of 11 test files from the inlined
  `vi.mock('.../logger', () => ({...}))` block to the
  shared `loggerMockFactory()` from `tests/helpers.ts`.
  Skipped `tests/config/redact.test.ts` which needs a custom
  `addRedactionMock` ref for assertions. Pattern is
  `vi.mock(path, () => loggerMockFactory())` -- the closure
  defers the factory reference past vi.mock's hoist (passing
  the factory directly TDZ-errors against the import).
  Updated the helper's docstring to reflect the closure form.
- `#339` Renamed local `makeReq` in `tests/i18n/i18n.test.ts`
  to `makeAcceptLanguageReq` to drop the shadow over
  `helpers.ts`'s `makeReq` (which stubs a different field).
- `#340` Replaced 10 `as any` casts in
  `tests/roomStore/roomStore.test.ts` with a single
  `mockReaddirOnce(entries)` helper using `as never`, and
  `as never` on the `readFile` mocks. The bypass is hidden
  in one helper + uses the more-honest `never` escape hatch
  instead of `any`.
- `#346` `vitest.config.ts` gains a coverage block (`provider:
  'v8'`, reporters: text + lcov + html, `include` server +
  web sources, `exclude` tests/dist/node_modules). No
  thresholds yet -- per audit 13 #338, the existing coverage
  surface is partial; adding thresholds without first
  scoping the uplift would either fail CI immediately or
  pretend the gaps don't exist. Run with `pnpm test
  --coverage`.

### Changed (rename + doc)
- `#362` `Client.anonymousUserName` -> `Client.userName`.
  Field name was a holdover from when login was optional;
  the "anonymous" prefix lost its meaning once login became
  required. 14 call sites updated (7 in code, 7 in tests).
- `#361` Documented in `logger.ts` that the redaction
  regex deliberately has no anchoring or word boundaries --
  substring matching is the correct semantics for "mask
  this sensitive value wherever it appears" (URL-encoded
  forms, JSON-encoded payloads, etc.). Audit 14 flagged
  this as a comment-clarity issue; code unchanged.
- `#368` `util/memo.ts` JSDoc that documents `memo()`
  was misplaced above `cachePromise`. Moved to the actual
  `memo` declaration. Added a note that `memo()` is the
  identity function in non-production envs (existing
  behavior, now documented).

### Verified clean (in code already)
- `#317` `filtersToPlexQueryString` export: audit claimed
  "only used in this file," but `tests/plex/util.test.ts`
  imports it for filter-shape coverage. Export retained;
  comment updated.
- `#358` `handlers/api.ts:50-51` comment trail: already
  rewritten in 0.4.20 #291 to read "the rateLimit middleware
  keys on req.socket.remoteAddress for the same reason."
  Audit was reading a prior version.
- audit 14 `#356` Unused `JoinRoomRequest` import in
  `room.ts`: surfaced + removed in 0.4.21 #345 (the new
  `noUnusedLocals` typecheck flag).

### Deferred
- `#338` Coverage uplift across `app.ts`, most of
  `handlers/*`, `config/load_env.ts`, `config/load_yaml.ts`,
  `config/defaults.ts`, most utils, and most of the web
  layer (components / screens / createStore / api/reely.ts).
  Tooling enabled via #346; the actual uplift is a multi-
  batch project that needs its own scope plan. Re-batch
  with a per-module priority list.

### Tests
- 259 tests still pass.

## [0.4.23] - 2026-05-22

### Changed (condensing pass, audit 13 -- owner-requested)

- `#322` New `<CloseIcon>` atom in `components/atoms/`. The
  16-unit close-X (M4 4l8 8M12 4l-8 8) was inlined 4 times
  across FilterPanel (3x: header + tag-chip + search-tag
  dismiss) and MatchMoment (overlay dismiss), only varying by
  stroke width. ~24 lines collapsed into one atom. Larger
  close-X variants in CardStack (24-unit) and UsersPopup
  (offset 13x10) are visually distinct and stay inline.
- `#323` New `components/organisms/cardStackGeometry.ts` with
  `INITIAL_COUNT`, `VISIBLE_COUNT`, `Y_BASE`, `Y_PEEK`,
  `Z_STEP`, `yForIndex`, and a new `springsForIndex(i)` helper.
  Three call sites (initial mount, the reducer's trailing
  settle loop, and the in-flight controller starts) now use
  the same helper to derive `{y, z, opacity}` from a stack
  index -- previously each inlined the same triple, with real
  drift risk. The two button SVG paths (heart + close-X)
  were also lifted to module scope. The audit also asked
  for a generic `settleAll(items)` helper; making it
  type-safe across the various Spring shapes ended up more
  confusing than the for-loop it replaces, so the trailing
  settle stays inline (one-liner with `springsForIndex`).
- `#324` New `hooks/useEscape(handler, enabled?)` hook.
  Room, MatchMoment, UsersPopup each registered the same
  window keydown listener with the same teardown -- ~18
  lines across three components, now one hook call each.
- `#325` `isIOS` moved from inline-per-file duplicates in
  `Card.tsx` + `PlexLinks.tsx` to a shared
  `utils/platform.ts`.
- `#326` New `fanOutLibraries(libraries, logPrefix, fn)`
  helper in `plex/util.ts`. The
  `Promise.allSettled(libraries.map(...))` + log-on-reject
  + accumulate-fulfilled pattern was repeated three times
  (PlexApi.getAllFilters, PlexApi.getFilterValues, the
  provider's getMediaCached). Helper is generic over the
  library shape so PlexApi's raw `PlexLibrary[]` and the
  provider's normalized `Library[]` both work.
- `#327` New local `isFilterApplicable(f)` predicate in
  FilterPanel. The `canApply` gate and `handleApply`
  serialization both used the same per-filter predicate
  verbatim; centralized so the two paths can't drift apart.

### Changed (Room.tsx desktop/mobile)

- `#281` New local `<ShareButton>` + `<FilterButton>`
  components inside Room.tsx. Both branches (desktop top-bar
  actions + mobile bottom-bar actions) previously inlined
  the same ~25-line button + SVG markup, only varying by
  CSS class, icon size, and stroke width. Now the buttons
  are defined once; each branch instantiates them with the
  variant props. The full desktop/mobile layout collapse
  the audit also suggested (combining the entire layouts)
  would require a much bigger restructure (different
  outer-container hierarchies: desktop has a sidebar +
  main, mobile has top-bar + content + bottom-bar) that
  isn't worth the prop-drilling cost. Scope: the two
  buttons only.

### Deferred

- `#321` FilterPanel.tsx split into FilterRow / FieldPicker
  / SearchControl sibling files. The extraction would need
  10+ props per sub-component (filters, filterValues,
  draft + setters, dispatch, expand state, etc.) which
  makes the cross-component interface uglier than the
  current long-but-flat file. The audit's "cuts the file
  in half" framing understates the prop-drilling cost.
  Re-batch when there's a clearer architectural shape.
- `#328` Reducer counters (`toastCounter`, `mediaVersionCounter`)
  moved into state. The refactor needs counter threading
  through 9 reducer cases + a rework of `tests/web/reducer
  .test.ts` (which currently relies on cross-call counter
  increments). Behaviorally correct today; deferred to a
  pure-reducer pass.

### Tests
- 259 tests still pass. No new tests this batch -- changes
  are structural (extraction) and don't introduce new
  behavior paths.

## [0.4.22] - 2026-05-22

### Fixed (frontend state machine + WS client, audits 13 + 14)
- `#301` Stale-localStorage login race. On every `connected`
  event, `createStore` auto-dispatched a login with whatever
  was in `localStorage.userName` -- if the user was actively
  typing on the login screen (e.g. a reconnect that landed
  mid-edit), the stored stale username would race their fresh
  input. Now: skip auto-login when `route === "login"`. An
  explicit Login route means the user is choosing identity
  manually; don't preempt.
- `#302` + audit 14 `#365` `client.addEventListener("message"|
  "connected"|"disconnected", ...)` listeners were never
  removed; HMR or repeated `createStore` calls double-bound
  every handler. Now all three listeners (plus the 5s
  loading-escape timer) ride on an `AbortController.signal`;
  a re-call aborts the prior signal first, tearing down every
  listener in one operation.
- `#303` The 5s loading-escape timer was unconditional and
  still fired (as a no-op) after the user had connected and
  joined. Now `clearTimeout(loadingEscapeTimer)` runs as soon
  as the `connected` handler fires; the timer also rides on
  the AbortController teardown.
- `#304` `loginSuccess` handler in `createStore.ts` has a
  necessary structural split (the in-room rejoin path needs
  side effects that reducers can't do). The split is now
  explicitly documented as three labeled paths (rejoin /
  deep-link / fall-through-to-reducer) with the side-effect
  boundary called out, so a future change can't lose the
  intent. No behavior change.
- `#305` `reducer.ts` switch is now exhaustive via a
  `const _exhaustive: never = action` default. The
  ServerMessage variants (login, logout, leaveRoom, rate,
  setLocale, requestFilters, requestFilterValues,
  applyFilters) get explicit no-op cases above the default --
  they're dispatched by the UI and forwarded to the WS
  client; the reducer doesn't react to them locally. Adding
  a new Actions variant without a case now errors at
  typecheck instead of silently falling through.
- `#308` `Login.tsx` `new URLSearchParams(location.search)`
  and `localStorage.getItem("userName")` ran on every render
  even though both are mount-stable. Moved to `useState(()
  => ...)` lazy initializers so the parse + storage read
  happen once on mount. Also dropped the redundant
  `storedName` local; `autoFocus={!userName}` is equivalent
  on the first render and a no-op on subsequent ones
  (autoFocus only consults the attribute on element
  insertion).
- `#310` `Toast.tsx` `useRef(new Map(...))` allocated a fresh
  Map on every render even though React keeps only the first.
  Moved to the lazy-ref pattern (`useRef<Map<...>|null>(null)`
  + a `getTimers()` accessor that constructs on first read).
- `#311` `JSON.parse(e.data) as ClientMessage` in
  `api/reely.ts:handleMessage`. A buggy server frame (or a
  non-object JSON literal like `null` / `42` / `"foo"`) used
  to fall through to the catch via a TypeError on
  `msg.type`. Now explicit shape guard: drop the frame with
  a warn log if `parsed` isn't an object with a string
  `type`. Surfaces the bad-frame case rather than relying on
  the catch.
- `#312` `waitForAnyMessage` had no rejection on socket
  close mid-wait; the 15s REQUEST_TIMEOUT_MS was the only
  escape, so any caller (login, joinRoom, etc.) froze the UI
  for 15s on every reconnect-mid-request. Now adds a
  `disconnected` listener that rejects immediately on
  socket close (with the same cleanup as the timeout path).
- `#313` `applyFilters` was synchronous; a tap-Apply during
  a reconnect silently dropped the message. Now matches the
  login / logout / setLocale pattern: `await this.waitForConnected()`
  before `sendMessage`. Fire-and-forget after that since the
  server replies via the room-wide `filterChangeApplied`
  broadcast (no per-caller waiter needed).
- audit 14 `#366` `Room.tsx` `seenMatchIds.add()` loop only
  ran when `fresh.length > 0`. Defensive fix: always sync
  the seen set with the current matches at the end of the
  effect, so a rejoin path that replays the same set keeps
  seen aligned.

### Tests
- 259 tests still pass. No new tests this batch -- the
  changes are localized state/listener-management updates,
  not new code paths. Coverage uplift for the WS-client +
  store layer (audit 13 #338) is scoped for 0.4.24.

## [0.4.21] - 2026-05-22

### Added
- `#283` **Biome lint** wired in as the project's lint stack
  (lock-in decision per the 0.4.21 design call). Single-tool /
  single-config / Rust-based (~10-30x faster than ESLint). New
  `biome.json` at repo root, `pnpm lint` + `pnpm lint:fix`
  scripts, new `biome lint` job in `ci.yml` gating on errors
  only (warnings surface in the step output but don't fail the
  build, so the broader cleanup can happen in dedicated batches).
  - Formatter intentionally disabled in this batch: server uses
    single quotes, web uses double; deferring format
    normalization to its own decision avoids a massive churn
    diff alongside the linter introduction.
  - First sweep cleared 28 files via `lint:fix` (mostly the
    `useImportType` wave), then the remaining 4 real errors
    were fixed: `let posterUrl: string | undefined` typing in
    the Plex provider, Toast.tsx forEach-callback void return,
    MatchMoment confetti array-index-key (ignored inline:
    fixed-length 20, no mutation), and the Loading.module.css
    progressive-enhancement `vh -> dvh` fallback (ignored
    inline: deliberate pattern).
  - 94 warnings + 8 infos remain (a11y findings, noExplicitAny,
    useExhaustiveDependencies, noNonNullAssertion, etc.) -- not
    blocking, queued for a dedicated accessibility / type-strictness
    batch.
- `#341` `.github/pull_request_template.md` added -- thin scaffold
  for the not-yet-meaningful contributor base, includes the
  4-file-rule reminder.

### Fixed
- `#284` README docker run example: `reely:latest` ->
  `cajunflavoredbob/reely:latest`. Anyone copy-pasting the
  snippet now actually pulls a real image.
- `#344` `.env.example` gains the `EXPOSE_PLEX_BASE_URL` knob
  (closes the doc parity gap from 0.4.15).
- `#345` Root `tsconfig.json` now sets `noUnusedLocals` +
  `noUnusedParameters` (matches the web's strictness floor).
  Caught one residual unused import: `JoinRoomRequest` in
  `room.ts` (= audit 14 #356, originally planned for 0.4.24 --
  fixed here while typecheck was breaking on it).
- `#348` `.dockerignore` excludes `tsconfig.test.json` and
  `vitest.config.ts` so they no longer ride into the Docker
  builder context.

### Mirrored
- `web/app/src/utils/sanitize.ts` now mirrors the bidi-override
  + zero-width strip from `internal/app/reely/util/sanitize.ts`
  (the 0.4.20 #292 work). Without it, a paste of a bidi-attacker
  name would display deceptively in the client until the server
  stripped it on submit.

### Changed
- `#343` `ci.yml` drops the `pull_request:` trigger (locked
  decision per the 0.4.21 design call). reely is a private repo;
  no fork-PR path to preserve. Eliminates the duplicate run on
  every PR push. If the repo ever goes public, the path forward
  is documented in the `on:` block comment: keep both triggers
  with `concurrency.group: ci-${{ github.event.pull_request.number
  || github.ref }}`.

### Closed-incidentally
- audit 14 `#356` Unused `JoinRoomRequest` import in `room.ts`
  -- surfaced + fixed via the new `noUnusedLocals` typecheck
  flag (#345). Originally scoped for 0.4.24 dead-code batch.

### Tests
- 259 tests still pass; no new tests this batch (build/CI
  changes only). The linter itself is the new gate.

## [0.4.20] - 2026-05-22

### Security
- `#282` **Plex token moved from URL searchParams to the
  `X-Plex-Token` HTTP header.** The prior pattern baked the token
  into the base URL's query string; every derived request carried
  it in `url.href`, which then landed in `logger.debug('Fetching:
  ...')` lines and in error bodies echoed back by Plex. Log
  redaction was the only guard. The header form removes the token
  from URL space entirely; redaction stays as defense-in-depth.
  Verified against python-plexapi's reference implementation,
  which uses the header form as the primary auth path on every
  Plex Media Server endpoint reely hits (capabilities, identity,
  library sections, library items, filters, filter values,
  thumbnails). Browser never sees these URLs (poster handler
  proxies bytes through reely's `/api/poster/...` route), so we
  never need the query-form fallback that python-plexapi reserves
  for embeddable URLs.
- `#294` URL scheme allowlist on `PlexApi` constructor: only
  `http:` and `https:` accepted. The prior `new URL(plexUrl)`
  would have happily accepted `file:///etc/passwd`, `gopher://`,
  or any URL the WHATWG parser allows -- a SSRF gap if PLEX_URL
  was ever operator-controlled but unscrutinized. The env loader
  already requires a scheme (audit 12 #207); this is
  defense-in-depth at the API-layer boundary.
- `#295` `getLibraryItems(key)` now validates `key` like
  `getFilterValues(key)` did. Same charset (`/^[a-z0-9_-]+$/i`),
  same path-traversal protection. Made the method `async` so
  validation failures surface as rejected promises (consistent
  with `getFilterValues`).
- `#292` Username sanitization now strips Unicode bidi-override
  + isolate codepoints (U+202A-U+202E, U+2066-U+2069) and
  zero-width characters (U+200B-U+200D, U+2060 word joiner,
  U+FEFF BOM). The prior pass stripped ASCII control chars + path
  separators but left these visual-deception vectors -- "alice"
  + ZWSP + "extra" used to display as "alice" but compare unequal
  to it.
- `#291` `wsConnectionsByIp` Map size cap of 1000 distinct IPs.
  The per-IP cap (20 sockets per IP) was already in place but
  the Map ITSELF could grow unboundedly. New IPs are refused
  with 429 once the cap is reached. (Eviction would lose slot
  accounting for active sockets, so refusal is the correct
  response.)
- `#306` Frontend `plexBaseUrl` scheme validation. `buildPlexLinks`
  now drops to the `app.plex.tv` fallback if the server-supplied
  `plexBaseUrl` isn't `http:` or `https:`. Defense-in-depth in
  case a future server bug or MITM supplies `javascript:` or
  `data:`.

### Added
- `#337` `X-Plex-Client-Identifier`, `X-Plex-Product` (`reely`),
  and `X-Plex-Version` (read from `VERSION` via `getVersion()`)
  headers on every Plex request. Closes the "Plex may rate-limit
  or refuse anonymous clients" concern by identifying reely to
  the server. The client identifier is `sha256(plexUrl)[:32]`:
  deterministic across reely restarts, unique per Plex server,
  no file-persistence needed.

### Changed
- `#287` Plex API response type renamed: `Library` ->
  `PlexLibrary` in `internal/app/plex/types/libraries_list.ts`.
  Disambiguates from the app-layer `Library` interface in
  `types/reely.ts` (different shape: Plex's is the raw API
  response with allowSync / agent / scanner / etc.; reely's is
  the normalized movie-only shape shipped to the frontend).
- `#315` + audit 14 `#352` Plex `serverIdCache` now pipes
  through `capabilitiesCache` instead of hitting `/identity`
  separately. Both endpoints return `machineIdentifier`; folding
  them saves one HTTP request per cold cache cycle and aligns
  the two values to the same source. `getIdentity()` method
  removed; the `Identity` type import removed.
- `#278` `PlexApiOptions.language` field removed. It was never
  wired through to any caller -- the Accept-Language header
  always fell to `'en'`. Two reasons the premise was wrong:
  (1) language is per-client (each WS connection has its own
  locale via the setLocale message) but PlexApi is shared across
  all connections in the provider, so a single field can't
  represent it; (2) Plex Media Server returns metadata in the
  agent's configured language regardless of Accept-Language.
  Dropped the field + the header logic rather than maintain
  dead scaffolding. The audit was right that it's broken; the
  fix is removal, not wire-through.

### Deferred
- `#299` Filter-value cross-library dedupe. Multi-library Plex
  servers return the same title (e.g. "Action") with different
  per-library keys; current dedupe-by-title keeps only the first
  key, so the second library's items get excluded. The fix needs
  either a wire-format change to `FilterValue.value` or a
  delimited-compound-value scheme coordinated with
  `filterToQueryString`. Both are bigger design changes than fit
  in this batch. Single-library deploys (the common case, and
  the owner's) don't hit it. Deferred to its own design pass.

### Tests
- +14 tests (245 -> 259):
  - Plex API: 6 `getLibraryItems` key-validation cases mirroring
    the existing `getFilterValues` set, plus 6 constructor
    URL-scheme cases (2 accept http/https, 4 reject
    file/gopher/ftp/data).
  - Sanitize: 2 new `sanitizeInput` cases covering bidi-override
    + isolate codepoints and zero-width / BOM / word joiner.

## [0.4.19] - 2026-05-22

### Fixed (critical correctness, audits 13 + 14)
- `#350` **WS upgrade slot leak.** `wsConnectionsByIp` count was
  incremented before `wss.handleUpgrade`; the decrement only fired
  in the success callback. A rejected handshake (malformed Sec-
  WebSocket-Key, protocol mismatch) left the slot permanently
  burned and could exhaust the per-IP cap with no recovery short
  of restart. Now `socket.on('close', releaseSlot)` is registered
  on the raw socket BEFORE `handleUpgrade`; the `slotReleased`
  idempotency guard makes the dual registration safe.
- `#279` `Media.id` switched from `libraryItem.guid` to
  `libraryItem.ratingKey`. `guid` is a metadata-agent identifier
  that can collide across libraries and changes on metadata
  refreshes; `ratingKey` is Plex's stable per-server numeric id.
  Swipes / ratings / matches all key on this value.
- `#280` `Room.fetchMedia` copies the provider's media array
  before shuffling. The prior in-place Fisher-Yates mutated the
  `memo1TTL`-cached array; concurrent rooms saw partially-
  shuffled lists that accumulated bias toward the front.
- `#286` WebSocket flush re-queues unsent messages instead of
  dropping the tail. A socket close mid-flush previously lost
  every message after the first failed send; the user's swipes
  during that window simply weren't recorded.
- `#289` (+ audit 14 #363 fold) Disk-sweep `JSON.parse` now
  guards on `typeof data === 'object'`. A file with a non-object
  JSON literal (`42`, `"foo"`, `null`) used to throw TypeError
  on property access, falling through to the catch block as
  "removed unreadable room file." The behavior was correct (file
  swept) but the path through TypeError was implicit. Explicit
  shape check makes the intent clear.
- `#290` `unlink` on TTL-sweep expired room files now logs non-
  ENOENT errors (EACCES, EBUSY, EISDIR). The prior
  `.catch(() => {})` swallowed real operational problems
  silently; files would leak with no signal.
- `#293` TLS cert + key files read at the TOP of the startup
  IIFE, before `cleanupExpiredRooms` + provider `isAvailable`
  checks + middleware mount. A bad cert path now fails-fast
  instead of burning every startup side-effect first.
- `#297` Plex provider `filterType!` non-null assertion replaced
  with `if (!filterType) continue;`. When both
  `type.Field?.find()?.type` and `filter.filterType` returned
  undefined, the `!` was lying about the type; the entry would
  have shipped `type: undefined` on the wire and broken
  operator-option rendering. Skipping is the correct fail-soft.
- `#307` `seenMatchIds` ref type narrowed from `Set<string>` to
  `Set<string> | undefined` (matches the actual `MutableRefObject`
  semantics under strict TS). No behavior change; the `?? new
  Set<string>()` fallback already handled the pre-seed window.
- `#309` (+ audit 14 #351 fold) `CardStack` reducer "remove"
  action now gates the `removed: true` write on the controller's
  `x.idle` check (same gate as the animation start). The prior
  code set `removed: true` even when the animation didn't start,
  so `finalizeRemove` never dispatched and the item stayed in
  the array marked removed forever (ghost entry). Now: either
  we animate AND mark AND finalize, or we do nothing.

### Verified clean (audits 13 + 14)
- `#288` `Client.handleLogin` username-change path: the
  `if (previousRoom) void saveRoom(previousRoom)` guard is
  already in place at `client.ts:247`. Audit was reading a
  prior version.
- `#298` `getMediaCached` cache keying: `normalizeFilters(filters)`
  serializes the FULL `filters` array including the library
  filter; two rooms with different libraryFilter produce
  different cache keys. Audit's "collide" claim is incorrect.

### Deferred
- `#296` Plex `getLibraryItems` pagination: re-categorized as
  efficiency rather than correctness (Plex's default no-paging
  behavior works; pagination is an optimization). Moved to
  0.4.25.

### Tests
- 245 tests still pass. No new tests in this batch -- the
  changes are localized and the surrounding behavior is
  covered. Coverage uplift is scoped for 0.4.24 per audit 13
  #338.

## [0.4.18] - 2026-05-22

### Added
- **Trivy image scan** wired into CI + release workflows --
  closes the second half of audit 12 #217 (the first half,
  `pnpm audit` against the lockfile, shipped in 0.4.13).
  - `ci.yml`: new `Trivy image scan` job builds an amd64
    single-platform image with `load: true` so Trivy can scan
    via the Docker daemon, reusing the same `type=gha` cache
    scope as the existing `docker` job. severity:
    CRITICAL,HIGH; `ignore-unfixed: true`; warn-level
    (continue-on-error) so the step renders red on findings
    but the job stays green -- doesn't block merges.
  - `release.yaml`: same scan as a hard gate before the
    multi-arch push. severity: CRITICAL only; no
    continue-on-error -- a CRITICAL CVE with an upstream fix
    blocks the publish until the base image or offending dep
    is bumped.

### Fixed (dependencies)
- `fast-uri` overridden to `>=3.1.2` (two HIGH CVEs: path
  traversal via percent-encoded dot segments, host confusion
  via percent-encoded authority delimiters). Transitive of
  `vite-plugin-pwa > workbox-build > ajv`.
- `@babel/plugin-transform-modules-systemjs` overridden to
  `>=7.29.4` (HIGH: arbitrary code generation from malicious
  input). Transitive of `vite-plugin-pwa > workbox-build >
  @babel/preset-env`. Build-time only.
- `brace-expansion` overridden to `>=5.0.6` (MODERATE: large
  numeric range defeats max DoS protection). Transitive of
  `vite-plugin-pwa > workbox-build > glob > minimatch`.
  Build-time only.
- `picomatch` overridden to `>=4.0.4` (HIGH: ReDoS via crafted
  extglob patterns). Transitive of Vite/Vitest build tooling.
  Build-time only.
- **`ws` direct runtime dep bumped `^8.18.1` -> `^8.20.1`**
  (MODERATE: uninitialized memory disclosure). The only
  runtime-visible fix in this batch; the rest are build-time
  transitives.

### Fixed (Docker image)
- Base image bumped `node:24.15.0-slim` -> `node:24.16.0-slim`
  (Node patch update; same Debian bookworm base).
- New `apt-get upgrade -y` step in the runtime stage. The
  Node official images on Docker Hub refresh their Debian
  package list on their own cadence, which often lags
  Debian's security publishes by days-to-weeks -- so even
  the freshest Node image still carried `libgnutls30
  3.7.9-2+deb12u6` (vulnerable) when Debian had already
  shipped `3.7.9-2+deb12u7`. The upgrade step pulls
  whatever Debian security updates are current at build
  time, trading a small amount of OS-layer reproducibility
  for security freshness. Clears five `libgnutls30` CVEs:
  - CRITICAL CVE-2026-33845 (DoS via DTLS zero-length frag)
  - CRITICAL CVE-2026-42010 (auth bypass via NUL in username)
  - HIGH     CVE-2026-33846 (DoS via DTLS handshake overflow)
  - HIGH     CVE-2026-3833  (nameConstraints policy bypass)
  - HIGH     CVE-2026-42009 (DoS via DTLS packet reordering)

### Verified
- Final Trivy scan: **0 vulnerabilities** across `debian` and
  `node-pkg` targets (`ignore-unfixed: true`).
- `pnpm audit --audit-level=low`: zero findings.
- 245 tests still pass.

## [0.4.17] - 2026-05-22

### Added
- Branding asset pack in new `docs/branding/` folder:
  - `reely-logo.svg` -- vector source
  - `reely-logo-1000.png` -- Docker Hub avatar (dark, 1000x1000,
    72 KB; well under Docker Hub's 1 MB cap)
  - `reely-logo-512.png` -- convenience export for any future
    PWA icon refresh
  - `reely-logo-light-1000.png` -- same mark on warm off-white,
    for light-themed docs / README headers
  - `reely-logo-32-preview.png` -- 32x32 stress-test reference
  - `README.md` -- describes each asset and where it gets used
- Distinct from `web/app/static/icons/`, which keeps the
  in-app PWA / favicon / Apple-touch icons untouched (those
  are wired into `manifest.webmanifest`; this drop does not
  change them).

### Notes
- Docker Hub avatar upload is a manual step via the Docker Hub
  web UI (Repository -> Settings -> upload image). No CLI /
  workflow automation; this commit just lands the asset in the
  repo so it's versioned and discoverable.

## [0.4.16] - 2026-05-22

### Changed
- Redaction registration extracted from `validate.ts` into a new
  `internal/app/reely/config/redact.ts` module. The validator is
  now a pure `(unknown) -> ReelyError[]` and no longer imports
  the logger. Closes audit 12 #237 + #276 (previously PARKED).
- `loadConfig` calls `registerRedactions(config)` after
  validation, unconditionally -- the redact function is
  field-wise defensive, so a config with errors on one field
  but a valid token still benefits from token redaction in
  boot-fail logs.
- `tests/config/validate.test.ts` drops its now-vestigial
  logger mock (the validator no longer pulls pino in
  transitively).

### Fixed
- `basicAuth.password` is now registered for redaction.
  Previously a small but real gap: `cmd/reely/main.ts` does
  `logger.debug(JSON.stringify(config))` at boot, and the
  password was riding through that at DEBUG level. Now masked
  alongside the Plex token + URL.

### Tests
- New `tests/config/redact.test.ts` (6 tests): server url +
  token registration, basicAuth password, malformed-url skip,
  empty-token skip, empty-password skip, no-op on missing /
  non-array servers. 245 total (239 -> 245).

## [0.4.15] - 2026-05-22

### Added
- `EXPOSE_PLEX_BASE_URL` env var / `exposePlexBaseUrl` YAML key
  (default `true`). When `false`, the WS `config` frame omits the
  Plex server's base URL; the frontend then routes all "Open in
  Plex" links through app.plex.tv instead of probing for direct-LAN
  reachability. Opt-out for deployments where the internal Plex
  address should not be visible to anyone with a WS connection
  (e.g. WAN-exposed reely without basicAuth). Closes audit 10 #165
  and audit 12 #226 (previously PARKED for a post-cycle design
  conversation).
- `EnvBool` parser in `load_env.ts` (accepts true/false, 1/0,
  yes/no, on/off case-insensitive; throws on anything else --
  silent coercion of a typo would hide misconfiguration).
- `ExposePlexBaseUrlInvalid` validator error.

### Changed
- `Config.exposePlexBaseUrl?: boolean` added to the shared type;
  default `true` in `applyDefaults` so 0.3.20 behavior is
  preserved on upgrade.
- `Client.sendConfig()` gates the `plexBaseUrl` field on the new
  flag. Other fields (`serverName`, `providerType`,
  `plexServerId`) are unchanged.
- `README.markdown` env-var table gains the new variable.

### Tests
- +23 new tests (216 -> 239): 16 in `loadConfig.test.ts`
  covering default / parse / true-aliases / false-aliases /
  garbage / env-overrides-yaml; 4 in `validate.test.ts` for
  the boolean-only rule; 3 in `client.test.ts` for the
  `sendConfig` gate.

## [0.4.14] - 2026-05-22

### Fixed (low / nit + cross-cutting, audits 11 + 12) -- closes the audit backlog
- `#187` `Room.seenMatchIds` comment rewritten -- spells out that
  React keeps only the first ref value, so `useRef(new Set(...))`
  inline would re-allocate per render.
- `#191` New `cachePromise<T>(fn, ttlMs?)` helper in `util/memo.ts`.
  `PlexApi.getCapabilities`, `PlexApi.getServerId`, and the
  provider's `getLibraries` were three near-identical hand-rolled
  blocks; all three now share the helper. Failures clear the slot,
  optional TTL bounds staleness.
- `#195` `Logo` `useId()` used directly instead of wrapped in a
  template literal -- React's `useId` already returns a unique
  value.
- `#196` `makeMedia(overrides)` factory in `tests/helpers.ts` so
  reducer-test payloads can build a real `Media` instead of a
  cast partial. Reducer tests now use it for the `match` case.
- `#254` Dropped dead `if (client && ...)` check in
  `Room.broadcastMessage` -- Map iteration never yields falsy.
- `#256` `getRoom(roomName: string)` accepts the bare name
  instead of the full `JoinRoomRequest` (only `.roomName` was
  ever read). `client.ts` + the tests pass the string directly.
- `#257` `flushPendingSaves` comment clarifies that rejection
  reasons surface via `saveRoom`'s own redacting log; the
  `Promise.allSettled` here just stops one failed save from
  aborting the queue.
- `#258` Logger default level is now `info`. `setLogLevel(config
  .logLevel)` runs after `loadConfig` and can drop it back to
  `debug` for the DEBUG operator config. The prior `debug`
  default printed startup debug lines until the config landed.
- `#260` Provider library list now caches with a 1-hour TTL
  (was process-lifetime). A Plex-side rename / add / remove
  shows up within the window without a restart.
- `#261` `PlexApi.fetch` error body truncated to 200 chars
  before being interpolated into the thrown `Error`. Plex error
  HTML pages can echo the request URL (which carries the token
  query); the redacting logger masks the token, but bounding the
  body length up front stops a multi-KB error page from
  hijacking a log line.
- `#263` PWA workbox runtime cache: Google Fonts stylesheets
  (StaleWhileRevalidate) + woff binaries (CacheFirst, 1y). Offline
  loads no longer break the fonts.
- `#264` PWA manifest `start_url` changed from `/` to `./` so a
  reverse-proxy `rootPath` deploy resolves the start URL relative
  to the manifest location.
- `#265` `userHue` regex doc updated to acknowledge that hyphens
  are kept (matches real usernames like `k-roy`). Dropping `-`
  would have re-colored every existing user with one.
- `#267` `.dockerignore` excludes `tests/`, `.github/`, `docs/`,
  `*.markdown`, `CHANGELOG.md`, `RELEASE_NOTES.markdown` from the
  build context. Smaller `docker build` uploads from a local
  checkout.
- `#272` `loadConfig` carries an explicit "Config layers, in
  priority order" doc block: env > yaml > defaults, with Docker
  secrets as a helper inside the env layer (not a separate one).
- `#274` Added a placeholder comment in `app.ts` noting
  pino-http per-request structured logs are deliberately not
  wired today. 429 + 401 paths log explicitly; revisit if
  full request-trail logs become useful.
- `#275` `app.disable('trust proxy')` after `express()` -- makes
  the no-proxy assumption explicit so a future contributor
  can't accidentally enable IP-spoofing via `X-Forwarded-For`.
- `#277` Cache-strategies catalog added to the header comment in
  `util/memo.ts`: lists every cache site, its TTL, and the helper
  it uses. Inconsistent by design (each cache picks the TTL its
  data tolerates), but now documented.
- `#235` `js-yaml` now parses with `JSON_SCHEMA`. YAML 1.1
  boolean aliases (`yes`/`no`/`on`/`off`/`y`/`n`) no longer parse
  as booleans -- `port: on` was previously `true`, which
  silently widened the validator's input shape.
- `#236` `getTrimmedEnv` Number-parse failure message now
  `JSON.stringify`-quotes the raw value. A hostile env value
  containing markup lands in logs as a safe literal instead of
  verbatim characters.

### Resolved without code change
- `#237` (parked with #276) Validator-to-logger decoupling is a
  wider refactor than the audit cycle scope.
- `#238` `LIBRARY_TITLE_FILTER=""` / `","` parses to undefined
  (same shape as "not set"): working as designed by `EnvList`'s
  contract.
- `#259` Fixed-window rate limit 2x burst at the boundary: not
  fixed. The audit itself flagged this as a design choice; a
  sliding-window / token-bucket rewrite isn't justified for the
  burst the existing window allows.

### Files
Backend: `internal/app/reely/util/memo.ts`,
`internal/app/reely/room.ts`, `internal/app/reely/roomStore.ts`,
`internal/app/reely/logger.ts`, `internal/app/reely/app.ts`,
`internal/app/reely/config/main.ts`,
`internal/app/reely/providers/plex.ts`,
`internal/app/reely/client.ts`,
`internal/app/plex/api.ts`.
Frontend: `web/app/src/components/atoms/Logo.tsx`,
`web/app/src/components/screens/Room.tsx`,
`web/app/src/utils/userHue.ts`,
`web/app/vite.config.ts`, `web/app/static/manifest.webmanifest`.
Ops: `.dockerignore`.
Tests: `tests/helpers.ts` (`makeMedia` factory),
`tests/room/room.test.ts` (getRoom string),
`tests/web/reducer.test.ts` (makeMedia).

216 tests pass. Typecheck + build clean.

### Audit backlog closed
Audits 11 + 12 (#175-#277) are fully addressed across 0.4.8-0.4.14.
Two findings parked by the owner's call (#165 + #226, both
`plexBaseUrl` exposure surface) and a handful of "won't fix /
verified clean" calls; everything else is closed.

Per the 4-file workflow rule (0.4.8), docker-compose.yml pin
bumped to 0.4.14.

## [0.4.13] - 2026-05-22

### Changed (build / CI / tests, audits 11 + 12)
- `#217` Added `pnpm audit --audit-level=high` as a warn-level
  CI job + a new `.github/dependabot.yml` opening weekly
  grouped PRs for npm / GitHub Actions / Docker base-image
  bumps. (Image vulnerability scan with Trivy still future
  work.)
- `#218` `release.yaml` Docker build step now uses
  `cache-from: type=gha` / `cache-to: type=gha,mode=max` so the
  release build can reuse ci.yml's cache from the tagged commit
  -- no more fully-cold release builds.
- `#219` `docker-compose.yml` carries a commented multi-service
  example showing how to gate a dependent service on
  reely's HEALTHCHECK via
  `depends_on: { reely: { condition: service_healthy } }`.
  The single-service quick-start above is unchanged.
- `#220` Release-gate `test` job in `release.yaml` now runs
  `pnpm build` after typecheck + test. The Docker layer cache
  could otherwise hide a regression in the UI build that only
  surfaces on a cold build -- which the release IS.
- `#247` `tests/handlers/api.test.ts` `beforeEach` explicitly
  `mockReset`s the `getConfig` mock before each test. Belt-and-
  suspenders alongside the new global `clearMocks`/`restoreMocks`.
- `#248` `tests/room/room.test.ts` `afterEach` clears the
  module-level `rooms` Map -- the one mutable singleton state
  left after the global mock cleanup.
- `#249` `i18n.getTranslations` sorts the offer list before
  passing it to the negotiator. Without the sort, `accepts`
  ties on q-weight broke to whatever readdir returned first --
  filesystem-dependent and prone to surprising "wrong locale"
  bugs on different platforms.
- `#250` `tsconfig.test.json` overrides `module: ESNext`
  + `moduleResolution: Bundler` so the test typecheck matches
  vitest's ESM runtime (Vite/esbuild under the hood). The main
  tsconfig.json stays on CommonJS for the production server.
- `#251` `vitest.config.ts` adds `clearMocks`, `restoreMocks`,
  `testTimeout: 5000`. Stops one test's spy state from leaking
  into another and bounds runaway awaits.
- `#252` ci.yml gained `concurrency: { group: ci-${{ github.ref
  }}, cancel-in-progress: true }`. Successive pushes to the same
  ref now cancel the in-flight CI instead of stacking.
- `#253` Collapsed ci.yml's typecheck/build/test into a single
  matrix job. The YAML is no longer three near-identical
  copies; the install cost stays the same (matrix cells are
  independent runners), but the pnpm cache + lockfile keep it
  cheap.
- `#268` ci.yml's docker job now builds **both**
  `linux/amd64` and `linux/arm64`, matching release.yaml's
  multi-arch list. The arm64 leg runs emulated and is slower
  than amd64, but an arm64 regression no longer surfaces
  only at tag time.
- `#269` `tests/helpers.ts` exposes `loggerMockFactory`
  -- the same `{ logger: {...}, addRedaction: vi.fn() }`
  block was repeated across >=11 test files. (Existing tests
  not migrated yet; the factory is in place for new tests
  + a future sweep.)

### Files
CI / build: `.github/workflows/ci.yml`,
`.github/workflows/release.yaml`, `.github/dependabot.yml`
(new), `docker-compose.yml`, `tsconfig.test.json`,
`vitest.config.ts`. Backend: `internal/app/reely/i18n.ts`.
Tests: `tests/helpers.ts`, `tests/handlers/api.test.ts`,
`tests/room/room.test.ts`.

216 tests pass. Typecheck + build clean.

Per the 4-file workflow rule (0.4.8), docker-compose.yml pin
bumped to 0.4.13.

## [0.4.12] - 2026-05-22

### Fixed (medium frontend, audits 11 + 12)
- `#241` Every error toast now carries `showTimeMs` so it
  auto-dismisses. `filterChangeError`, `leaveRoomError`,
  `logoutError`, `requestFiltersError` (reducer cases) and the
  `request-timeout` / `reconnect-rejoin-failed` toasts dispatched
  from `createStore` all use a `5000ms` TTL. The
  `connection-failure` toast stays sticky (cleared explicitly on
  reconnect, by design). +4 tests.
- `#242` Dropped the duplicate `requestFilters` dispatch from
  `FilterPanel`'s mount effect. Room.tsx already prefetches the
  filter catalog (so the `filterChangeApplied` toast can resolve
  titles even before the panel opens). On desktop -- where both
  components are mounted at the same time -- both effects used
  to fire in the same render tick and produce two server-side
  requests for one room.
- `#243` Room's Escape handler now gates on `filterPanelOpen` --
  the listener is only bound while the panel is open. The
  prior unconditional listener stacked alongside UsersPopup's
  and MatchMoment's, all firing on the same Esc keystroke (each
  one a no-op for the wrong overlay, but noise).
- `#244` `seenMatchIds` reseeds from `previousMatches` on a room
  name change. RoomScreen doesn't unmount across the 0.3.19
  auto-rejoin path, so without this the previous room's ids
  persisted and a same-mediaId match in the new room wouldn't
  celebrate. Added a `lastSeenRoomName` ref to detect the
  transition.
- `#246` Documented the `createStore.dispatch` rejection-catch
  scope: catches request-method timeouts only; fire-and-forget
  methods (`rate`, `applyFilters`, `setLocale`) resolve once the
  WS frame is sent and produce no rejection path here.

### Verified clean
- `#245` `CardStack` `.item` already has `touch-action: pan-y`
  (CardStack.module.css:64); audit's claim was stale.

### Parked (the owner's call, deferred to a design discussion)
- `#226` `plexBaseUrl` on the WS config frame (LAN IP exposure to
  any WS client). Sibling of audit 10 #165; revisit when warranted.

### Files
Frontend: `store/reducer.ts`, `store/createStore.ts`,
`screens/Room.tsx`, `organisms/FilterPanel.tsx`.

216 tests pass (+4 net new for #241 error-toast TTLs).
Typecheck + build clean.

Per the 4-file workflow rule (0.4.8), docker-compose.yml pin
bumped to 0.4.12.

## [0.4.11] - 2026-05-21

### Fixed (medium backend hardening + perf, audits 11 + 12)
- `#185` `normalizeFilters` now sorts each filter's value array in
  addition to sorting the filters by key. Two semantically-equivalent
  filter sets that differ only in checkbox-toggle order
  (`["Action","Drama"]` vs `["Drama","Action"]`) now hit the same
  5-minute cache entry instead of forcing duplicate Plex fetches.
- `#190` `Room.notifiedMatchKeys` is now FIFO-capped at
  `NOTIFIED_MATCH_KEYS_CAP = 8000` entries. The dedupe Set was
  bounded in practice by the 6h TTL keeping rooms small, but a
  long-lived heavily-used room could theoretically grow to ~40k
  strings. Map/Set insertion-order iteration makes
  `values().next()` the oldest entry.
- `#221` Logger redaction list pruning policy documented inline --
  not pruned across config reloads today is acceptable because
  reely doesn't reload at runtime; the comment flags that a future
  hot-reload feature must add eviction at the same time.
- `#222` `loadTranslation` cache behavior documented inline: keys
  on the input locale, not the candidate that resolved, so
  fallbacks duplicate storage but can't cross-poison.
- `#223` `loadTranslation` validates the parsed JSON is a flat
  string -> string map before returning it. A hand-edited file
  with nested objects or non-string values is rejected and the
  fallback chain continues.
- `#224` `getRootPath` now gates the final value through an
  explicit allowlist regex (`/^(\/[A-Za-z0-9._\-/]*)?$/`). A
  hostile `X-Forwarded-Prefix` that survives the proxy chain is
  dropped to `""` rather than letting characters land in href/src
  contexts of the served HTML.
- `#225` Poster handler validates `providerIndex` as a
  non-negative integer string (`/^\d+$/`) BEFORE coercing with
  `+`. `+'Infinity'`/`+'NaN'` no longer index out of bounds and
  hit the !provider guard by accident.
- `#228` `loadRoom` logs `"Failed to restore room ... (file kept;
  most likely the provider refetch failed)"` instead of the prior
  generic `"Failed to load room"`. Operators correlating "room X
  didn't restore" with "Plex was down at boot" now see the link.
- `#230` `roomFilePath` carries a defense-in-depth resolved-path
  assertion: throws if the joined path doesn't resolve under
  `ROOMS_DIR`. `sanitizeRoomNameCanonical` already strips path
  separators upstream, so this is a backstop against a future
  sanitization regression.
- `#231` `cleanupExpiredRooms` swapped the in-memory pass order
  from `removeRoom -> unlink` to `unlink -> removeRoom`. Closes
  the cleanup-vs-create race: in the old order, a concurrent
  `createRoom("foo")` could land between `removeRoom` and
  `unlink`, write the fresh file via `saveRoom`, and then the
  cleanup's `unlink` would delete the just-written file --
  leaving an orphaned in-memory room with no disk presence. With
  unlink-first, any concurrent createRoom sees the room still in
  the map and gets `RoomExistsError`; the user retries after the
  removeRoom completes.
- `#232` Added a per-IP concurrent-WS cap (`MAX_WS_PER_IP = 20`)
  in the WS upgrade handler. A single IP that already has 20
  active sockets gets `429 Too Many Requests` on the next
  upgrade. Per-conn message rate limits stack on top of this so
  a busy IP can't multiply the per-conn cap by opening hundreds
  of sockets. Slot is reserved eagerly + released on
  `close`/`error` to keep the count tight.
- `#233 + #239 + #273` Provider/server abstraction commit
  documented inline in `app.ts`: reely is single-server by design
  today; the `servers` array stays for forward-compat with
  multi-PROVIDER (Plex + Emby + Jellyfin) for the 1.0 release.
  No code change.
- `#234` `getMediaCached` 5-min freshness caveat documented:
  a swipe on a since-deleted Plex media id still succeeds against
  the cached metadata but the poster proxy would 404. Acceptable
  for the LAN use case.

### Files
Backend: `providers/plex.ts`, `room.ts`, `roomStore.ts`,
`handlers/api.ts`, `handlers/poster.ts`, `handlers/template.ts`,
`i18n.ts`, `logger.ts`, `app.ts`.

212 tests pass (no new tests; defensive + doc-heavy batch covered
by typecheck + build). Per the 4-file workflow rule (0.4.8),
docker-compose.yml pin bumped to 0.4.11.

## [0.4.10] - 2026-05-21

### Fixed (high frontend + dead code, audits 11 + 12)
- `#178` `Room.tsx` `pendingMatch` is now a `pendingMatches: Match[]`
  queue. When several matches arrive in the same tick (server
  batches, simultaneous likes) every match gets its celebration
  moment instead of only the newest one. `dismissPending` shifts
  the head of the queue. The "first match of the session gets the
  full overlay" heuristic moved to a `bigCelebrationShown` ref so
  a batch can't blow past `matchCount === 1`.
- `#181`/`#262` Removed the dead `--vh: 1vh;` CSS variable from
  `main.css`. The JS shim that kept it in sync was removed in
  0.4.6 #171; no rule still references it.
- `#182`/`#266` Narrowed `Toast.id` from `number | string` to
  `string`. Every producer (`nextToastId`, the literal
  `"connection-failure"`) yields a string; the defensive
  `String(t.id)` calls in the renderer dropped.
- `#183 + #184` (folded) `FilterPanel` `expandedRows` switched
  from `Set<number>` keyed on the draft index to `Set<string>`
  keyed on `filter.key`. Removes both the
  setState-updater-inside-setState anti-pattern (audit 11 #183,
  self-inflicted from 0.4.6 #137) AND the index-shift dance in
  `removeFilter` (audit 11 #184) -- one change closes both
  findings cleanly.
- `#214` Documented the `Actions` vs `ClientActions` split in
  `store/types.ts`: components dispatch `ClientActions` via
  `Dispatch`; the reducer processes the wider `Actions` (which
  also covers WS-driven server pushes + internal store
  transitions). `apply()` is internal-only.
- `#215` `useStore` is now generic over its key array so
  destructured callers get the narrowed `Pick<Store, K>` shape
  instead of the full `Store`. `useSelector` was already
  generic; `useStore` was widening the inferred K back to
  `keyof Store`.
- `#216` `Login.tsx` snapshots `trimmedRoom` AT submit time into
  `pendingJoinRoom: string | null` instead of reading the latest
  ref value at deferred-join time. The 0.4.6 #115 ref-update
  approach still reflected post-submit typing because the input
  isn't disabled until the room exists. Capturing at the click
  moment closes that window.
- `#227` Removed `Client.locale` -- written in `handleSetLocale`,
  never read anywhere. Translations are fetched directly from the
  payload's `language`.

### Files

Frontend: `store/index.ts`, `store/types.ts`, `screens/Login.tsx`,
`screens/Room.tsx`, `organisms/FilterPanel.tsx`, `atoms/Toast.tsx`,
`main.css`. Backend: `client.ts`.

212 tests pass (no new tests this batch -- the UI changes are
hard to cover meaningfully without React testing infrastructure
that isn't wired up here yet; behavior covered by existing
roomStore + reducer + sanitize tests). Typecheck + build clean.

## [0.4.9] - 2026-05-21

### Fixed (high backend + config, audits 11 + 12)
- `#176` `Client.handleRequestFilters` + `handleRequestFilterValues`
  marked `private` (every other dispatch target already was).
- `#177` `emitJoinError` now surfaces `RoomLimitError` with its real
  message instead of collapsing to the generic "unexpected error"
  copy. `JoinRoomError['name']` union widened to carry
  `"RoomLimitError"` -- the disk-load branch of `joinOrCreateRoom`
  can hit `addRoom`'s `MAX_ROOMS` cap, and users now see "room
  limit reached" instead of a misleading generic message.
- `#201` `Room.broadcastMessage` stringifies the payload once and
  forwards the raw frame to every recipient via a new
  `Client.sendRaw(json)` helper. The prior per-client `sendMessage`
  path re-ran `JSON.stringify` for each user -- with Media-bearing
  messages (match, filterChangeApplied) the per-user payload is
  multi-KB and the savings compound.
- `#203` `removeRoom` now carries an explicit MEMORY-ONLY contract
  comment warning that callers wanting full removal must also
  unlink the persisted file. Today only `cleanupExpiredRooms`
  calls it, and it does the unlink explicitly; this doc keeps a
  future caller from leaking files that resurrect on startup.
- `#204` TTL sweep now treats a persisted room file with no
  `lastSwipeAt` AND no `updatedAt` as ancient and sweeps it.
  Prior code's `undefined < cutoff === false` would leave such
  files orphaned forever. +1 test.
- `#205` `loadRoom` extended-shape check covers every required
  PersistedRoom field (`updatedAt` was missing) AND types every
  optional field. The new `isPersistedRoomShape` helper names the
  offending field in the reject log so an operator hand-editing
  the file gets a clue. +4 tests.
- `#209` `readDockerSecret` switched to `fs/promises.readFile` --
  the loader is already async, so the sync read was blocking the
  event loop for no reason. `loadFromEnv` and `loadConfig`
  cascade the async through.
- `#210` (verify) `normalizeAndValidateConfig` was already named
  to reflect its in-place mutation (0.3.9 #M2) with the comment
  block explaining why. No 0.4.9 change.
- `#211` (verify) `cachedConfig` cannot diverge from the returned
  config since 0.4.3 #99 -- both are the same object reference;
  the cache is just gated on `blockingErrors.length === 0`. No
  0.4.9 change.

### Resolved without code change (#206)
`Room.applyFilters` per-room cooldown bypass by joining N rooms:
**won't fix.** The threat is contrived -- bounded by `MAX_ROOMS=500`
+ the per-connection WS message rate limit (0.3.5). The realistic
threat (accidental rapid-fire by one user in one room) IS covered.
A per-user global cooldown would add infrastructure for no real
benefit.

### Added (tests)
- `tests/roomStore/roomStore.test.ts` adds 1 case for the TTL
  no-timestamp sweep (#204) and 4 cases for the extended loadRoom
  shape validation (#205).

## [0.4.8] - 2026-05-21

### Fixed (critical + showstoppers, audits 11 + 12)
- `#180`/`#197` `docker-compose.yml` bumped to
  `cajunflavoredbob/reely:0.4.8` (was stuck at 0.3.6, 13 releases
  stale) and the comment now documents the **workflow rule** added
  in 0.4.8: this pin tracks `VERSION` on every release bump
  alongside `package.json` + `CHANGELOG`.
- `#198` Partial env config no longer wipes YAML credentials.
  `loadFromEnv` now gates each bundle on having both required
  halves (server: url+token; basicAuth: userName+password;
  tlsConfig: certFile+keyFile). Setting only `LIBRARY_TITLE_FILTER`
  /`AUTH_USER` / `TLS_CERT` no longer emits a half-bundle that
  spreads over the YAML and erases the partner field. +4 tests.
- `#199` `readDockerSecret` throws `EmptyDockerSecretError` when a
  mounted secret file is empty or whitespace-only -- an operator
  who mounted a secret and left it blank is misconfigured, not
  opting out. Silent fallback to env would have masked "auth
  bypassed" as "auth not configured". +2 tests.
- `#175`/`#213` WebSocket reconnect listener leak closed. Each
  `handleOpen` now tears down the prior reconnect's pending
  `flushAfterRejoin` listener before registering a new one --
  a reconnect-loop on the login screen no longer accumulates
  listeners across the page session.
- `#200` `uncaughtException` handler now best-effort calls
  `flushPendingSaves()` before `process.exit(1)`, guarded by a
  1500ms watchdog so a wedged disk still lets us exit. Up to 2s
  of swipes are preserved across crashes.
- `#207` `PLEX_URL` without a scheme now throws at config load
  instead of silently downgrading to `http://`. Operators must
  type `http://` or `https://` explicitly so the channel choice
  -- and whether the Plex token rides in cleartext -- is a
  deliberate decision. +1 test.
- `#212` `loadConfig` errors (malformed YAML, scheme-less
  PLEX_URL, empty secret, etc.) are now caught in `main.ts` with
  a fatal exit. Previously escaped to the global
  `unhandledRejection` handler which only logs, leaving the
  process alive without a config.
- `#188`/`#208` `readDockerSecret` rewritten as a single
  `readFileSync` + `try`/`catch` on `ENOENT`. Eliminates the
  prior `existsSync` + `readFileSync` TOCTOU window.

### Fixed (minor)
- `#179` `loadConfig.test.ts` env cleanup no longer deletes
  `LIBRARY_TYPE_FILTER` / `MOVIE_LINK_TYPE` -- both dead since
  0.4.1's movies-only scope collapse. Also added `SECRETS_DIR`
  to the cleanup list so tests don't leak directory paths.

### Added (deps + tests)
- `tests/config/load_secrets.test.ts` (new) covers the
  TOCTOU rewrite + empty-file detection + missing-file fallback.
- `tests/config/loadConfig.test.ts` adds five cases: scheme-less
  PLEX_URL rejection, three partial-env bundle gates
  (LIBRARY_TITLE_FILTER / AUTH_USER / TLS_CERT alone preserve
  YAML), and the full-env basicAuth-override sanity check.

### Workflow rule (added)
Every version bump touches **four files** now (was three):
`VERSION` + `package.json` + `CHANGELOG.md` + `docker-compose.yml`.
The compose pin must match the current VERSION on every release
to prevent the example file from drifting (audit 11 #180 caught
a 13-release drift between 0.4.7 and 0.4.8).

## [0.4.7] - 2026-05-21

### Changed (build / infra, audits 9 + 10)
- `#105` CI Docker build step now uses GHA cache layer reuse
  (`cache-from`/`cache-to: type=gha`); each CI run no longer
  rebuilds the multi-stage image from scratch.
- `#122` Dockerfile pins Node to `node:24.15.0-slim` for both the
  builder and runtime stages (exact-patch reproducibility). CI
  floors to `24` so upstream 24.x compat issues surface in PR
  CI before they reach the production image.
- `#123` Documented inline in `ci.yml` that `pnpm/action-setup@v6`
  reads `packageManager` from `package.json`, keeping CI and the
  Dockerfile in lockstep with one source of truth.
- `#124` Added a comment in `.dockerignore` explaining that the
  multi-stage Dockerfile's `COPY --from=builder /app/dist` bypasses
  the ignore by design -- a local stale `dist/` can't pollute the
  runtime image.
- `#126` Documented the DockerHub PAT scope expectation
  (repository-scoped, not account-wide) in `release.yaml` next to
  the login step.
- `#164` `docker-compose.yml` pinned to `cajunflavoredbob/reely:0.3.6`
  (the current released tag) instead of `:latest`. Restart can't
  silently upgrade between releases; operators bump intentionally
  on each upgrade.
- `#173` `release.yaml` now has a `test` job gating the build via
  `needs: test` -- typecheck + tests run on the exact tag SHA
  before the image is built and pushed. Closes the "tag race
  reaches release before CI completes" hole.

### Fixed (smaller observations)
- `#125` Extracted `tests/helpers.ts` with the shared
  `makeReq` / `makeRes` / `makeNext` Express stubs and
  `makeWs` / `push` / `sent` / `flush` WebSocket helpers. Removed
  the duplicate definitions from `tests/middleware/rateLimit.test.ts`
  and `tests/client/client.test.ts`.
- `#168` `handlers/template.ts:get()` now returns `''` the moment
  any intermediate node along a dotted key path isn't an object,
  instead of silently surfacing the parent string when a later
  segment ran off the end. e.g. context `{ a: "x" }` with keyPath
  `['a', 'b']` now resolves to `''`; previously returned `"x"`.
- `#172` `tsconfig.json` carries an explicit comment block on the
  CommonJS choice + the migration path to ESM (flip `module` to
  `NodeNext`, add `"type": "module"`, rewrite the few `require()`
  call sites). The migration trigger is a critical-path dependency
  dropping CJS support.
- `#174` Split `CHANGELOG.md` -- 0.3.6 and earlier entries moved
  to `docs/CHANGELOG-archive.md`. Active changelog is now ~940
  lines instead of ~2040; the archive remains pinned for
  historical reference. No content lost; pointer at the bottom of
  the active file links across.

### Resolved without code changes
- `#153` (verify `interpolate` consumers don't pre-escape): no
  action needed; verification was already done in 0.4.3 #144.
- `#165` (Plex base URL shared to the browser): **PARKED** per
  the owner's call -- the 0.3.20 design was deliberately client-side
  probed for LAN reachability detection. A server-side probe is a
  re-architecture, not a fix; revisit when warranted.
- `#167` (canonical room names allow spaces): won't fix. Replacing
  internal whitespace with `-` in the canonical form would orphan
  existing on-disk room files (URL `+`/`%20` encoding works
  correctly in URL bars, share links, and Plex; the chat-client
  link-split case is rare and easily worked around).
- `#169` (i18n regex evaluated 3 times): not fixed. The audit
  itself flagged this as "fine; just noting" -- the three-pass
  filter is correct, drops invalid candidates, and falls back to
  English cleanly. An `LOCALE_TAG.test(locale)` early-exit would
  collapse one branch but lose the candidate-array clarity.

**Audit backlog closed.** Audits 8 + 9 + 10 (#85-#174) are fully
addressed: this is the last batch of audit-driven work in the
0.4.x cycle.

## [0.4.6] - 2026-05-21

### Fixed (low frontend polish, audits 9 + 10)
- `#115` `Login` reads `trimmedRoom` through a ref inside the
  deferred-join effect so a future edit path can't ship a stale
  roomName between submit and the user-success message landing.
- `#117` `Avatar` and `UserPill` now type the inline `style={}`
  object as `CSSProperties & { "--hue": number; "--progress": ... }`
  so a typo in a CSS-variable key (e.g. `"--huee"`) becomes a
  typecheck error instead of silently producing a var no rule
  reads.
- `#119` Dropped the unreachable `else { return <p>No route for
  ${route}</p> }` branch in `main.tsx`. The route table is
  `Record<Routes, ...>` so the lookup is total. The IIFE is also
  gone; the lookup table is hoisted to a module-scope `ROUTES`.
- `#120` The four room-event reducer cases (`match`,
  `userJoinedRoom`, `userLeftRoom`, `userProgress`) now guard with
  `if (!state.room) return state;` rather than spreading
  `state.room!`. A server-contract violation that delivered one of
  these to a roomless client is a safe no-op instead of a thrown
  TypeError. +4 tests.
- `#121` `setLocale` now carries a comment noting that
  fire-and-forget is intentional (no `setLocaleSuccess` reply, the
  language hint is advisory, Plex falls back to English).
- `#136` Room's `seenMatchIds` ref is now initialized lazily inside
  the effect on first run. The prior `useRef(new Set(...))`
  allocated a fresh Set on every render even though React only
  keeps the first.
- `#137` `FilterPanel.addFilter` computes the new row's index
  inside the `setDraft` updater so two batched `addFilter` calls
  can't both read a stale `draft.length` and expand the wrong row.
- `#151` Extracted a `updateConnectionToasts` helper inside the
  `updateConnectionStatus` reducer case, replacing the nested
  ternary inside an array literal. Logic identical, reads cleanly.
- `#152` Documented that `state.dispatch` is a stable reference
  for the lifetime of the store, so the `useDispatch` selector
  doesn't need `useShallow`.
- `#159` Replaced the `(action as any).payload` cast in
  `createStore.dispatch` with a `dispatchToClient(client, msg)`
  helper that exhaustively switches on `msg.type` and lets TS
  check each payload against the matching `ReelyClient` method.
  Adding a new ServerMessage variant without a case now fails the
  build at the `never` exhaustiveness check.
- `#170` Dropped the unnecessary `/g` flag on `userHue`'s
  `\p{Letter}` regex -- it's only used with `.test()` and is
  constructed inline per call. `/g` + `.test()` has the
  `lastIndex` footgun on shared regexes; dropping it removes any
  ambiguity even though this particular use was safe.
- `#171` Removed the `--vh` JS shim from `main.tsx`. CSS `dvh`
  (dynamic viewport height) is supported by every browser reely
  targets (Safari 15.4+, Chrome 108+, Firefox 101+, all 3+ years
  old) and updates automatically as the mobile address bar
  collapses / expands. CSS consumers in `main.css`,
  `Layout.module.css`, `Card.module.css`, and `CardStack.module.css`
  switched from `calc(var(--vh) * N)` to `Ndvh` directly.

### Resolved without code changes
- `#118` (`buildPlexLinks` called twice per Room render): already
  resolved -- the call result is cached as `const webUrl` inside
  the map callback. No 0.4.6 change.
- `#160` (counter reset on logout/leave): not fixed. The
  never-resetting counters are intentional and documented:
  `toastCounter` collides on reset, `mediaVersionCounter` is keyed
  by React `key=` and a reset would reuse old keys (caused the
  stale-cards bug fixed by 0.3.11 #14). `Number.MAX_SAFE_INTEGER`
  is generous; no behavior issue.

### Added (tests)
- `tests/web/reducer.test.ts` adds four cases covering the new
  `if (!state.room) return state;` guards on the four room-event
  cases (#120).

## [0.4.5] - 2026-05-21

### Fixed (low backend hardening, audits 9 + 10)
- `#107` `loadTranslation` now logs the path + error when a locale
  file fails to load for a reason other than ENOENT (the normal
  "fall through to the next candidate" case). A broken locale file
  no longer falls through silently to English.
- `#108` `cleanupExpiredRooms` logs the full `filePath` when removing
  an unreadable room file, not just the basename. Easier to grep /
  `ls` from a shell.
- `#109` `isOriginAllowed` lowercases both sides before comparing
  the Origin host to the Host header. RFC 7230 host comparison is
  case-insensitive; a proxy that forwards a mixed-case Host no
  longer 403s a legitimate same-origin WS upgrade.
- `#110` `template.ts` + `Tr.tsx` interpolate regexes switched from
  lowercase-only char class + `/i` flag to explicit `[a-zA-Z0-9_.]`
  + plain `/g`. Functionally identical; reads what it means.
- `#111` Provider `getFiltersCached` walks `type.Field` with
  optional chaining instead of a non-null assertion. A Plex type
  entry without a `Field` array (rare but the response shape allows
  it) now falls through to `filter.filterType` cleanly.
- `#112` Plex thumb URL parsing now uses a named regex match
  (`/\/library\/metadata\/(\d+)\/thumb\/(\d+)/`) instead of
  positional `split('/')` destructuring. Robust to a future Plex
  format change adding / removing prefix segments.
- `#113` `memo` now uses a sentinel symbol (`Symbol('memo-unset')`)
  for the cache-miss check. The prior `cachedResult === undefined`
  check would re-execute on every call for a function that
  legitimately returned `undefined`.
- `#114` Documented the `ReadableStream as any` Web<->Node bridge
  on `ReelyProvider.getArtwork` itself, not just at the consumer
  (`handlers/poster.ts`). The cast is the documented contract --
  TS's Node + DOM ReadableStream typedefs are incompatible at this
  boundary even though both are runtime-valid.
- `#145` `logger.applyRedactions` rewritten as a single combined
  regex pass with a cached compiled pattern that invalidates on
  the next `addRedaction`. Was O(N*L) per message; now O(L) with
  one Set check on registration. Regex metacharacters in registered
  values are escaped so a `+` / `?` / `.` in a token is matched
  literally. +4 tests.
- `#148` Added a comment on `PlexApi.getAllFilters` noting that
  the provider's `getFiltersCached` is the cache; a future direct
  caller of the api method bypasses it intentionally.
- `#157` `PlexApi.fetch` JSON parse failure now wraps the original
  error as `{ cause }` so the redacting logger sees the underlying
  stack instead of just the generic wrapper message.
- `#161` `getRootPath` strips ALL whitespace from the prefix (not
  just edges) so a misconfigured proxy can't ship a path containing
  embedded whitespace into the inline-script `data-root-path`.
- `#162` `PlexApi` constructor calls `addRedaction(plexUrl)` +
  `addRedaction(plexToken)` itself for defense-in-depth. The
  primary registration still happens in `validate.ts` during
  `loadConfig`; this just covers a test or future code path that
  constructs `PlexApi` directly. +1 test mock fix.

### Resolved without code changes
- `#106` (`Array.find` vs `.some` in `getMediaForUser`): already
  superseded by 0.4.2 #146 -- the rewrite uses a `Set` and `.some`,
  not `.find`. No 0.4.5 change.
- `#147` (`storeRating` recomputes likes; consider a likeCount
  counter): won't fix. The only-fire-once invariant is locked by
  0.4.3 #98's per-(mediaId, like-set) dedupe Set, and the per-call
  `filter(([, r]) => r === 'like')` cost is trivial (K = ratings
  per item; bounded by the small user count per room). A likeCount
  field would change the persisted-room schema for negligible
  benefit.

### Added (tests)
- `tests/util/memo.test.ts` adds a case proving the sentinel
  switch fixes #113: a memoized function returning `undefined` is
  cached after the first call.
- `tests/util/logger.test.ts` (new) covers the combined-regex
  redaction path: single + multi-value redaction, regex
  metacharacters matched literally, and post-registration
  invalidation.

## [0.4.4] - 2026-05-21

### Removed (dead surface, audits 8 + 10)
- `ClientMessage { type: "media"; payload: Media[] }` -- declared but
  never sent, received, or switched on (#89 [H]).
- `CreateRoomFilterMetadata` interface -- declared in `types/reely.ts`,
  never imported (#89 [H]).
- `Message = ServerMessage | ClientMessage` alias -- declared, never
  imported (#89 [H]).
- `Spacing` and `Color` types in `web/app/src/types.ts` -- design-token
  enums with no consumers (#140 [J] = part of #89).
- `routeParams` field on the `navigate` action payload + on `Store` --
  set on dispatch and persisted in state, but never read anywhere
  (#89 [H]).
- `Spinner` atom (`Spinner.tsx` + `Spinner.module.css`) -- replaced by
  the pulsing wordmark on the Loading screen in 0.4.0; no other
  consumer (#139 [J]).

### Kept on purpose
- `User.avatarImage` field and `ReelyProvider.isUserAuthorized()`
  method remain as scaffolding for the upcoming Emby / Jellyfin
  provider work (the owner's call on audit 8 #89).

### Fixed
- `#102` / `#132` `MatchesList` now wires `useLocalPlexReachable` +
  passes `plexBaseUrl` + `preferLocal` to `buildPlexLinks`, matching
  `Room.tsx`'s desktop sidebar. Was a 0.3.20 regression: `MatchesList`
  was calling `buildPlexLinks(m, config?.plexServerId)` with only two
  of four args, so the matches popup always built `app.plex.tv` links
  even on LAN-only deployments where the local Plex web UI is
  reachable. Same call also de-duplicated (was invoked twice per
  row -- once to gate, once to read `.webUrl`).
- `#133` `Avatar.tsx` now imports `userHue` from
  `utils/userHue.ts` instead of inlining the same hash. Self-inflicted
  dup when the util was extracted in 0.4.0; risk of drift if one was
  ever updated without the other.
- `#138` Removed the unused `assert` import from
  `internal/app/reely/config/validate.ts`.
- `#142` Narrowed `Capabilities` to `{ friendlyName, machineIdentifier }`
  (the only fields the codebase reads). Widened `ContentRating` to
  `string` -- Plex routinely returns values outside any reasonable
  allowlist (regional ratings, "Unrated", "X"), and the previous
  exhaustive union would crash typecheck on a Plex response that
  violated it.
- `#143` `validate.ts` only calls `addRedaction(server.url)` after
  `new URL(server.url)` parses; an invalid URL no longer wastes the
  redaction registration (and a malformed value wouldn't legitimately
  end up in log output anyway).
- `#156` Dropped the no-op unary `+` on `media.duration` in `Card.tsx`
  (now typed `number | undefined`; the truthy gate already narrows it).
- `#166` Documented `main.ts`'s partial-error policy: exactly one
  `ServersMustNotBeEmpty` boots in unconfigured mode; any other error
  shape (even alongside `ServersMustNotBeEmpty`) is fatal.

## [0.4.3] - 2026-05-20

### Fixed (medium UI + backend defensive, audits 9 + 10)
- `#95` Documented the asymmetric `unhandledRejection` vs
  `uncaughtException` policy in `cmd/reely/main.ts`. No code
  change -- just an explicit rationale (every async path that
  matters wraps its own errors; killing the server on a stray
  rejection does more damage than letting it surface in logs)
  + the override knob (`NODE_OPTIONS='--unhandled-rejections=strict'`).
- `#96` `Client.getUser()` replaces the `getUsername()!` non-null
  assertion with an explicit runtime check that throws on
  violation. The invariant (handlers gate on `isLoggedIn`) was
  fine but out-of-band; throwing surfaces a violation cleanly
  instead of synthesizing a `User` with `userName: "undefined"`.
- `#97` Guarded the three `progress / media.size` divisions
  (`Client.handleJoinRoom`, `Room.storeRating`, `Room.getUsers`)
  against an empty-media room. Normally impossible (`fetchMedia`
  throws `NoMediaError` on empty) but a future code path could
  ship `Infinity` / `NaN` on the wire and break progress UI.
- `#98` `Room.notifyMatch` is now deduplicated by
  `(mediaId, sorted-liker-set)` via a per-Room
  `notifiedMatchKeys` Set. Defense-in-depth: today's storeRating
  produces a unique like-set per call, but a future regression
  (or audit-followup code path) can't double-broadcast.
- `#99` `loadConfig` now only caches the config when there are no
  blocking validation errors (`ServersMustNotBeEmpty` is
  whitelisted because main.ts boots in unconfigured mode on it).
  A truly broken config (`port: "abc"`, malformed YAML, etc.)
  leaves `cachedConfig` unset, so a downstream `getConfig()` call
  throws instead of returning the half-validated object.
- `#101` `CardStack`'s `areEqual = () => true` memo comment is
  rewritten as an INVARIANT block warning future maintainers
  that no props flow through this memo at runtime, and listing
  the three supported paths if a new piece of state must drive
  the stack (mediaVersion remount, Zustand selector inside, or
  remove the always-true memo).
- `#103` `removeToast` reducer case filters by `id` instead of
  object identity. A dispatched payload that wasn't
  reference-equal to the stored toast used to silently no-op
  the removal; now any payload carrying the right id removes it.
- `#104` `sanitizeUserInput` / `sanitizeRoomNameDisplay` accept
  an optional `maxLength` so the length bound holds even if the
  JSX `maxLength` attribute ever drops out. `Login.tsx` passes
  64 / 48 to mirror the server's slices.
- `#130` `Media.duration` and `Media.rating` are now optional
  (`number | undefined`) and the provider only `Number()`-coerces
  when the underlying Plex field is present. Stops `NaN` flowing
  on the wire when Plex omits the field; matches what consumers
  truthy-gate around today.
- `#134` `Logo` now generates a unique `<linearGradient>` id per
  render via `useId()`. Two Logos on the same page previously
  collided on the hard-coded `id="ry-mark-grad"`.
- `#144` `Tr.interpolate` rewritten to a single `replace` pass
  with a function replacer (matching the server-side
  `template.ts:interpolate` pattern). Folds in `#150` (no-action
  info note), `#154` (charset now allows dotted keys so
  translations can use `${a.b.c}` consistently with the server),
  and `#155` (the redundant outer capture group is gone).

### Added (tests)
- `tests/web/reducer.test.ts` adds two cases covering the
  `removeToast` by-id filter (#103) -- including a
  non-reference-equal payload that the prior identity filter
  would have missed.
- `tests/web/sanitize.test.ts` (new) covers the optional
  `maxLength` parameter on both client-side sanitizers (#104)
  and that the cap is applied AFTER stripping.

## [0.4.2] - 2026-05-20

### Fixed (medium correctness + perf, audits 8 + 9 + 10)
- `#86` `ReelyClient` no longer flushes queued `rate` messages on the
  WebSocket `open` event -- the new socket hasn't logged in or
  rejoined a room yet, so the server's `handleRate` would drop every
  one (no `userName`, no `room.users` membership). Flush is now
  deferred until the next `joinRoomSuccess` / `createRoomSuccess`
  arrives on the new socket (the reducer's 0.3.19 auto-rejoin path
  triggers it).
- `#87` `useElementWidth` now uses a `ResizeObserver` so the swipe-
  dismissal threshold tracks orientation changes, responsive
  desktop<->mobile transitions, and any container resize. The earlier
  measure-once-on-mount left it stuck at the original width.
- `#88` `getMediaCached` fetches every selected Plex library in
  parallel via `Promise.allSettled`. Room create + filter-apply
  latency on a multi-library server is now bound by the slowest
  library instead of the sum of all of them. Matches the pattern
  already used in `getAllFilters` / `getFilterValues`. An individual
  library failure is skipped rather than sinking the whole result.
- `#100` `useElementWidth`'s `transform` callback is read through a
  ref so the effect doesn't re-subscribe when the parent recreates
  the fn inline each render. No caller passes one today, but the
  latent dep was misleading.
- `#131` + `#158` Debounced-save queue lifecycle now plays nicely
  with the TTL sweep and graceful shutdown. The internal
  `pendingSaves` Map stores `{ timer, room }` instead of just the
  timer, exposing two new helpers:
    - `cancelPendingSave(name)` -- called by `cleanupExpiredRooms`
      so an in-flight debounce can't recreate a JSON file the sweep
      just unlinked.
    - `flushPendingSaves()` -- awaited by `Application.shutdown`
      before tearing down so a swipe that landed in the 2s window
      before SIGTERM is persisted, not orphaned. The shutdown
      handler is now async; the abort-listener fire-and-forgets it
      with explicit `void`.
- `#135` Toast effect now cancels timers for toasts removed
  externally (e.g. by click). The pending `setTimeout` would
  otherwise fire later as a no-op against the already-removed toast
  while its entry stayed in `timers.current` until the component
  unmounted -- a slow leak across long sessions. `removeToast`
  added to the effect deps.
- `#146` `Room.getMediaForUser` builds a `Set<mediaId>` of the
  user's existing ratings in one pass and filters against it, in
  place of the prior `.filter(...).find(...)` (O(N*M) -- N media x M
  ratings per item). Fires on every `joinRoomSuccess` and
  `applyFilters`; matters on the ~4000-movie / few-hundred-rating
  shape.
- `#149` Provider-level `getLibraries` caches the in-flight Promise
  (not the awaited value), mirroring the `PlexApi.getCapabilities`
  / `getServerId` pattern. Two concurrent first-callers no longer
  fire duplicate API requests. Failures aren't cached.
- `#163` Added `compression` middleware in front of the SPA shell +
  static assets. Skips `/api/poster/*` (binary, already encoded).
  Cuts SPA delivery substantially on slow links.

### Added (deps)
- `compression@^1.8.1` + `@types/compression@^1.8.1` for #163.

### Added (tests)
- `tests/roomStore/roomStore.test.ts` adds five cases covering the
  new debounce-queue lifecycle: write-after-window, burst
  coalescing, `cancelPendingSave`, `flushPendingSaves`, and the
  cleanup-cancels-pending-save invariant (#131).

## [0.4.1] - 2026-05-20

### Changed (scope)
- reely is now movies-only by design. `LIBRARY_TYPE_FILTER` env var and
  the `libraryTypeFilter` YAML/Config field are removed; shows / music
  / photos cannot be selected. Music never actually worked (Plex calls
  it `"artist"`, reely's filter compared to the string `"music"`), and
  matching is the wrong UX for the others (shows are a longer
  commitment that fits recommendations better; music/photos don't fit
  the model). Existing configs with `libraryTypeFilter:` are silently
  ignored (the validator doesn't error on unknown server fields). The
  `LIBRARY_TITLE_FILTER` for restricting to specific movie libraries
  is unchanged.
- `Media.type` and `Library.type` are now the string literal `"movie"`
  instead of a `LibraryType` union; the wire field stays for future
  narrowing room.

### Fixed (high-severity audit batch, audits 8 + 9 + 10)
- `#85` `Client.handleLeaveRoom` / `handleLogout` now `this.room = undefined`
  after evicting the user (or being preempted by a soft-refresh
  replacement), and `handleRate` asserts that this Client is still the
  active connection for its username in `room.users` before storing.
  Closes a path where a logged-out or left connection could keep
  emitting `rate` messages that mutated the prior room's ratings.
- `#90` `loadRoom` now per-entry validates each persisted ratings
  tuple (`[mediaId, [[user, 'like'|'dislike', time], ...]]`) before
  constructing the `ratings` Map. A malformed or hand-edited room file
  is rejected with an error log instead of silently producing a Map
  with corrupt values.
- `#91` `PlexApi.isAvailable` now gates on `machineIdentifier` (always
  present on a Plex response) instead of `.size` (the capability-record
  count, legitimately `0` on a freshly-created server with no
  libraries). A new Plex server is no longer falsely reported
  unreachable.
- `#94` `MatchMoment` auto-dismiss effect now depends on
  `[isBig, onDismiss]` instead of an empty deps array, so a parent
  flipping `isBig` mid-toast re-runs the effect and reschedules the
  timer correctly (the parent's `key={match.media.id}` remount path
  is still the common case).
- `#127` movies-only collapse: `LibraryTypes` / `LibraryType` union
  removed from `types/reely.ts`; provider filter hardcodes the movie
  type at the boundary; `getFiltersCached` no longer iterates / merges
  `availableTypes`; `Filters.filters[].libraryTypes` field removed;
  README, `.env.example`, and the "Does it support TV shows?" FAQ
  updated; two `validate.test.ts` cases retired.
- `#128` `Room.applyFilters` returns `Media[] | null`; `null` signals
  a losing concurrent apply, and `client.ts` skips the
  `notifyFilterApplied` broadcast + `saveRoom` on null. The previous
  code returned the losing-call's media unconditionally and broadcast
  a stale filter/media set to every client even though `this.media`
  had moved on.
- `#129` `filterToQueryString` returns `Array<[key, value]>` (one entry
  per filter value); `filtersToPlexQueryString` returns
  `URLSearchParams` and uses `.append()`; `PlexApi.fetch` and
  `getLibraryItems` take `URLSearchParams` instead of a
  `Record<string, string>`. Multi-value filters now go to Plex as
  repeated keys (`genre=Action&genre=Drama`), so a value containing
  `,` (titles, taglines, custom labels) can no longer split into two
  values on the Plex side.

### Resolved without code changes
- `#92` (operator slice off-by-one): not a bug -- `=` is a legitimate
  operator that produces an empty suffix by design (`key=value`).
  The audit framing was a misread. No change.
- `#93` (CardStack keyboard handler stale `items`): already fixed in
  0.3.11 (audit 4 #15) -- the deps array is `[items, connectionStatus]`.
  Audit 9 read a stale snapshot.

### Added (tests)
- `tests/plex/util.test.ts` updated for the new
  `filterToQueryString` / `filtersToPlexQueryString` shapes, plus a
  case covering a value containing `,` to lock in the #129 fix.
- `tests/client/client.test.ts` adds two cases for #85: rating after
  a `leaveRoom` is dropped; rating from a stale connection after a
  soft-refresh replacement is dropped by the membership assertion.

## [0.4.0] - 2026-05-19

### Changed
- Loading screen now shows the lowercase "reely" wordmark as a pulsing
  brand mark (Instrument Serif italic, gradient text) in place of the
  generic spinner. Honors `prefers-reduced-motion`.
- Room top bar (desktop + mobile) replaces the avatar stack with
  text-based username pills. Each pill carries a hashed-hue base
  tint plus a left-to-right background fill showing that user's swipe
  progress. The current user's own pill gets a subtle outer ring.
  Names truncate at 14 chars with the full name in the hover tooltip.
- Username pill row collapses to a `+N` overflow badge after a
  per-layout threshold (5 on desktop, 3 on mobile). Tapping the row
  opens a new "In this room" popup that lists every user with
  per-user progress and includes the Leave Room action. The old
  avatar-as-leave-button affordance is removed.
- Card stack now reads as a stack: the next two cards visibly peek
  above the front card (each shrunk by perspective foreshortening,
  Logo-stack style) and the front card sits on a soft drop shadow.
  Larger per-index z-step also makes a back card's "rise forward"
  more pronounced when the front card is swiped away.
- Share + Filter buttons (desktop + mobile) gained consistent
  140ms transitions, a press-feedback `scale(0.97)`, and a
  pink `:focus-visible` outline for keyboard navigation.
- Mobile bottom bar now shows a dashed "matches will appear here as
  you swipe" placeholder before the first match, so the bar's
  height stays stable when the strip later populates.

### Added
- `UserPill` atom, `UserPillRow` molecule, and `UsersPopup` organism
  components, with shared `userHue` utility extracted from Avatar
  so pills and avatars share one color per user.

## [0.3.21] - 2026-05-19

### Docs
- README's "Can I filter by genre, year, or other metadata?" FAQ
  rewritten to match the actual instant-apply + toast flow (the old
  copy still described the propose/accept/reject voting flow removed
  in 0.2.4) and the "Clear filters" affordance from 0.3.15.

### Changed
- Lowercase branding pass: every user-facing and prose mention of
  the project is now "reely", matching the wordmark and `<title>`
  set in 0.2.x. Covers the README, docs, the Unraid template's
  display name and descriptions, the basic-auth realm prompt, the
  `/health` response body, startup log lines, the Config-screen
  heading and body, and dev-facing comments. Code identifiers
  (`ReelyProvider`, `ReelyError`, `ReelyClient`, `ReelyUnknownError`)
  are unchanged.
- Empty-state match copy now reflects the actual match condition
  (any 2+ users liking the same media). The sidebar's "Movies you
  all love will land here." and MatchesList's "Movies you both love
  will land here." are both replaced with "Movies two or more of
  you love will land here."

## [0.3.20] - 2026-05-19

### Added
- "Open in Plex" now auto-detects whether the browser can reach the
  local Plex server. On the LAN the link goes directly to the Plex
  server's web UI (no plex.tv round-trip, works without internet);
  off-LAN or in mixed-content situations it falls back to the
  existing app.plex.tv URL. The server's config message carries the
  Plex base URL (no token); the browser HEAD-probes `/identity` with
  a 1.5s timeout once per session and caches the result.

## [0.3.19] - 2026-05-19

### Fixed
- A WS reconnect while in a room no longer dumps the user back to
  the login screen if the reconnect happens within 10 minutes of
  the disconnect. The room is silently rejoined (the server's
  ratings/userProgress/matches survive the round trip); past the
  10-minute window the existing kick-to-login behavior still
  applies, so a long absence (closed laptop, network change hours
  later) still requires explicit re-entry. Explicit leave or logout
  drops the auto-rejoin candidate so the user isn't pulled back
  into a room they deliberately left. Audit #17 -- the last open
  finding.

## [0.3.18] - 2026-05-19

### Fixed
- `requestFilterValues` now correlates its response to the request
  by filter key. FilterPanel fires one `requestFilterValues` per
  key, so several are often in flight at once; `waitForAnyMessage`
  resolved on the first response of a matching *type*, so a waiter
  could resolve against another key's response. Each waiter now
  resolves only on its own key's response (both response shapes
  already echo the key). `waitForAnyMessage` gained an optional
  match predicate for this. (Audit #12 -- the targeted fix; a
  protocol-wide request-ID scheme was considered and declined as
  overkill since no other request type has overlapping calls.)

## [0.3.17] - 2026-05-19

### Fixed
- The TTL sweep no longer expires a room that still has clients
  connected. `cleanupExpiredRooms` skipped only on swipe recency, so
  a room idle 6h with users connected was removed from the registry
  and its file unlinked -- orphaning those clients' `Room` reference
  and letting a fresh join build a second, divergent `Room` under the
  same name (split-brain). The in-memory pass now skips rooms with
  connected users, and the disk pass skips files for any room
  currently in memory. Applying filters also refreshes the room's
  activity clock, so a room where users actively filter (without
  swiping) is no longer expired out from under them.

## [0.3.16] - 2026-05-19

Cleanliness batch -- the final batch from the follow-up audits.

### Removed
- The 33KB base64 PNG `net.unraid.docker.icon` LABEL from the
  Dockerfile (the file was 35KB because of it; the Unraid template
  already references the icon by URL).
- Dead frontend code: the entire `components/icons/` directory,
  `ButtonContainer`, `UserProgressItem`, `Field`, `TextInput`
  (and their CSS), the empty `web/app/src/hooks/` directory, the
  unused `ReelyClient.waitForMessage` method, and the unused
  `linkType` field on `PlexApiOptions`.
- A redundant `as ServerMessage` cast and a stray `delete` on a class
  field in `client.ts`; a stale "as of 0.2.13" comment in a test.

### Changed
- `docker-compose.yml` uses the published `cajunflavoredbob/reely`
  image instead of `build: .`, so the README quick-start ("copy
  `docker-compose.yml`, run") works without the full repo checked
  out.
- `@types/node` bumped 22 -> 24 to match the Node 24 runtime; pnpm is
  pinned via a `packageManager` field so the version is consistent
  across CI, Docker, and tooling.

### Fixed
- `loadRoom` uses the room's filename as its canonical identity
  rather than trusting the `roomName` stored inside the file.
- Accessibility: the login name/room inputs have `aria-label`s, and
  the mobile match strip is keyboard-operable (`tabIndex` + Enter/
  Space handler).

### Docs
- `.env.example` now documents all supported environment variables,
  not just `PLEX_URL` / `PLEX_TOKEN`.

## [0.3.15] - 2026-05-19

Medium batch from the deeper follow-up audits.

### Fixed
- Active filters can now be cleared from the UI. The FilterPanel
  button was disabled with an empty draft, so an applied filter set
  could never be removed; it now shows "Clear filters" when the room
  has active filters and an empty draft.
- `filterChangeError` (filter-apply cooldown / no-media) had no
  reducer case and failed silently; it now raises a toast. Same for
  `leaveRoomError` and `logoutError`.
- Editing the cached-login username chip and submitting now re-logs
  in under the new name -- it used to join the room under the stale
  server-side username.
- `emitCreateError` no longer casts an arbitrary `err.name` into the
  `CreateRoomError` union; an unrecognized error maps to
  `UnknownError`.
- Swipes dropped in the brief gap between the socket closing and the
  UI noticing are queued and flushed on reconnect, instead of being
  lost.
- `room.media` is snapshotted once per operation in `storeRating` /
  `getMatches` so a concurrent `applyFilters` can't swap it mid-loop;
  `applyFilters` is now last-requested-wins (a sequence token).
- `MatchMoment` is given a React `key` so a consecutive match no
  longer reuses a stale dismiss timer; new-match detection compares
  match identity instead of `matches.length`, so a rejoin no longer
  pops celebrations for old matches.
- The Docker `HEALTHCHECK` probes `https` when TLS is configured --
  a TLS container was being marked unhealthy.
- Empty segments in comma-separated env lists are dropped
  (`a,,b` -> `["a","b"]`).
- `getMediaCached` keys on `JSON.stringify` so filter values
  containing `,` or `|` can't collide.
- The username input has a `maxLength` of 64 to mirror the server.

### Security
- The reverse-proxy docs now cover the WebSocket Origin check:
  forward the `Host` header or set `ALLOWED_ORIGINS`, or WS upgrades
  get a 403.

### Changed
- A bare-host `PLEX_URL` (no scheme) still defaults to `http://` but
  now logs a warning that the Plex token will travel unencrypted.
- The header-less-request locale log dropped from info to debug
  (non-browser pollers were spamming it).
- `start` / `serve` npm scripts set `NODE_ENV=production` so
  memoization is active when running the built server outside Docker.
- CI now builds the Docker image (no push) so a broken Dockerfile is
  caught in PR CI; `release.yaml` is guarded to tag refs and pins the
  Docker Hub namespace.

### Docs
- Removed references to the in-browser setup UI (removed in 0.3.4)
  from the README and configuration docs.

## [0.3.14] - 2026-05-18

Critical + High batch from the deeper follow-up audits.

### Security
- Basic Auth no longer accepts an empty password. `AUTH_PASS=""`
  passed the type check, booting the app "protected" by the
  trivially guessable `base64("user:")` -- a silent auth bypass. The
  validator now requires a non-empty username and password, and
  `checkBasicAuth` fails closed on empty credentials.
- `PlexApi.getFilterValues` rejects a filter key that isn't a plain
  `[a-z0-9_-]+` token. The key is interpolated into a Plex API URL
  path; the API layer no longer relies solely on caller-side
  validation to prevent path traversal / SSRF.
- The rate limiter keys on `req.socket.remoteAddress` (the real TCP
  peer) instead of `req.ip`, which is derived from the spoofable
  `X-Forwarded-For` header when `trust proxy` is enabled.

### Fixed
- Ctrl-C no longer restarts the server. The config-reload loop in
  `main.ts` treated a clean shutdown's `undefined` status as "reload
  and start again", so SIGINT closed the server then immediately
  re-listened. The reload loop was vestigial -- `ConfigReloadError`
  was never thrown and there is no config watcher -- so it has been
  removed entirely. The server now starts once and exits cleanly.
- `SIGTERM` (what `docker stop` sends) now runs the graceful-shutdown
  path; only `SIGINT` was handled before.
- Shutdown state is per-Application-instance, not a module global,
  and the signal handlers are registered exactly once -- the old
  loop re-registered a SIGINT handler and leaked the previous
  server's listener/intervals on every iteration.
- Ratings are persisted after rating activity (debounced ~2s) so a
  crash before disconnect no longer loses recent swipes and matches.
- The Pass/Like buttons now gate on a live connection like the drag
  and keyboard paths -- tapping them while disconnected used to
  remove the card locally while the rating was silently dropped.
- A malformed or unreadable default `config.yaml` is no longer
  silently ignored; only a genuinely missing default file is
  tolerated. Other errors (bad YAML, permission denied) are fatal.
- The WebSocket reconnect backoff no longer resets on every `open`.
  A server that accepted the handshake then immediately closed used
  to reconnect at the base delay forever; the counter now resets
  only after a connection stays open ~10s. A socket `error` listener
  was also added (errors were previously swallowed).
- Request methods (`login`, `joinRoom`, ...) time out after 15s
  instead of hanging forever on a missing server reply; a timeout
  surfaces a toast.
- `addRoom` (the disk-load join path) now enforces the `MAX_ROOMS`
  cap -- previously only `createRoom` did, so a directory of
  persisted rooms could load past it.

### Changed
- Env config no longer index-merges into the YAML server entry. If
  env defines a server at all it replaces the YAML server outright --
  a per-field merge could pair an env `PLEX_TOKEN` with a YAML
  server URL it was never meant to pair with.
- `release.yaml` pins `softprops/action-gh-release@v2`; `@v3` does
  not exist and the release job failed after the image was pushed.

## [0.3.13] - 2026-05-18

Cleanup batch from the two follow-up code audits -- the last of the
launch-audit findings.

### Fixed
- The keyboard/swipe `useFirstChildWidth` hook measured the stack's
  first child, which was the dislike button, not a card -- the
  swipe-throw threshold was computed against a ~44px width. It now
  measures the card-stack element itself.
- `loginSuccess` handling stored `userName` via a non-null assertion;
  a missing field would have persisted the literal string
  "undefined" to localStorage and auto-"logged in" as that user. It
  now only persists a real non-empty username.
- `memo1` / `memo1TTL` deleted a cache entry on promise rejection
  even if a fresh entry had since replaced it. The rejection cleanup
  now only removes the entry if it's still the rejected promise.
- The config-error log line interpolated an array directly, printing
  stray commas between entries; it now joins cleanly.

### Security
- `addRedaction` now also registers the URL-encoded form of a
  redacted value. The Plex token/URL travels in request URLs as an
  encoded query-param value, and the literal-substring redaction
  wouldn't have matched the encoded form if the value contained
  percent-encodable characters.

### Changed
- The test suite is now type-checked in CI (`typecheck:tests` via a
  new `tsconfig.test.json`; `tests/web` folds into the UI tsconfig).
  Previously `tests/` was outside every typecheck scope.
- The Docker `HEALTHCHECK` resolves the port from `config.yaml` as
  well as `$PORT`, so a port set in either place is probed correctly.
- `package.json` `engines.node` raised to `>=24.0.0` to match the
  Docker base image, CI, and CONTRIBUTING.

### Removed
- Dead code: the never-thrown `UserAlreadyJoinedError` (and its
  `JoinRoomError` name and error-mapping branch), the unused
  `userName` parameter on `getRoom`, the unused `connect`/`disconnect`
  store actions, and ten unused atom components (`AddRemoveList`,
  `Button`, `MenuGroup`, `Pill`, `Popover`, `SegmentedControls`,
  `Select`, `Switch`, `Version`, `VisuallyHidden`).
- Unused `mime-types` / `@types/mime-types` dependencies.
- Stale Deno-era comments and `.gitignore` entries (`pkg.ts`,
  `build`) left over from the MovieMatch origin.

## [0.3.12] - 2026-05-18

Security + robustness batch from the two follow-up code audits.

### Security
- The WebSocket upgrade now performs a Cross-Site WebSocket Hijacking
  (CSWSH) check. When `basicAuth` is unset the upgrade did no Origin
  check, so any site a victim visited could drive their Reely server.
  A browser-sent `Origin` must now either be same-origin with the
  request `Host` or appear in the new `ALLOWED_ORIGINS` config (a
  reverse-proxy escape hatch). Requests with no `Origin` (non-browser
  clients) are still accepted.
- `escapeHtml` now also escapes `'`, and `interpolate()` HTML-escapes
  every substituted value (translations included) -- previously a
  translation value was injected into the HTML shell unescaped.

### Fixed
- `interpolate()` re-scanned the mutated template string for each
  placeholder, so duplicate or overlapping placeholders could resolve
  into the wrong spot. It now does a single global regex pass.
- Basic Auth byte-compared the whole `Authorization` header, so a
  proxy that lowercased the scheme or changed whitespace broke auth
  for everyone. The scheme and credentials are now parsed per RFC 7617
  (case-insensitive scheme, tolerant whitespace) before the
  constant-time compare.
- `handleRate`, `handleSetLocale`, and `handleRequestFilterValues`
  now validate the inbound payload shape, consistent with the other
  hardened handlers -- a malformed message no longer throws into the
  catch-all.
- Re-logging in with a different username while in a room left the
  old name as a ghost in other clients' lists with orphaned
  `userProgress`. The old identity now cleanly leaves the room
  (notify + progress cleanup).
- `loadRoom` validated only that the file was JSON, then cast it to
  `PersistedRoom`. It now checks the shape (`roomName`, `ratings`,
  `userProgress`, `createdAt`) and ignores a malformed file.
- The poster proxy now aborts the upstream Plex fetch when the
  browser disconnects mid-stream, instead of pulling bytes into a
  dead response; stream errors are handled rather than left unhandled.
- `getAllFilters` / `getFilterValues` fetched library sections
  serially and one failing section rejected the whole result. They
  now fetch in parallel with `Promise.allSettled` and skip a section
  that fails.
- The room "share" button called `navigator.clipboard` unguarded;
  it is `undefined` on plain `http://` (Reely's deployment target),
  so the copy threw while the UI still showed "Copied!". It now
  falls back to a `textarea`/`execCommand` copy and only shows
  "Copied!" on a real success.

### Changed
- Every Plex API request now carries a 30s timeout, so a hung or
  unreachable Plex server can no longer stall callers indefinitely.

## [0.3.11] - 2026-05-18

Launch-readiness batch -- correctness, lifecycle, and reconnect fixes
from two follow-up code audits.

### Fixed
- `notifyMatch` re-fired for an already-matched item on every later
  rating, including a third user's dislike -- spurious match
  broadcasts. It now fires only when the rating just added is a like.
- The WebSocket reconnect backoff started instant and grew linearly
  with no cap or jitter, hammering a downed server and making clients
  retry in lockstep. Replaced with capped exponential backoff (500ms
  base, 30s ceiling) plus random jitter.
- `pingInterval` leaked on a failed startup: it was created before
  `_shutdownFn` (the only thing that clears it) was assigned, so a
  `listen()` error orphaned a 30s interval each config-reload cycle.
  The interval is now created only after `listen()` succeeds.
- Shutdown could hang waiting on slow plain-HTTP streams (e.g. a
  poster proxy). `_shutdownFn` now calls `httpServer.closeAllConnections()`
  so the close completes promptly. Added `unhandledRejection` /
  `uncaughtException` handlers that log through the redacting logger.
- `waitForConnected` bound its listener to the current socket's
  `open` event; if that socket was already closing, the reconnect
  swapped in a new socket and the listener never fired, hanging every
  awaited call. It now waits on the client's own `connected` event,
  which survives reconnects. (Completes the 0.3.10 F3 fix.)
- CardStack could show a previous room's cards after a rejoin:
  `room.mediaVersion` (the remount key) reset to 0, colliding with an
  earlier mount. `mediaVersion` is now a monotonic counter.
- The keyboard rating handler closed over a stale `connectionStatus`
  (effect deps were `[items]` only); it now re-binds on change.
- `onDragEnd`'s displacement branch ignored `connectionStatus`, so a
  long drag while disconnected removed the card locally while the
  rating was silently dropped. The whole removal is now gated on a
  live connection.
- Docker `data/` directory is now created in the image before the
  `chown`, so the `reely_data` named volume mounts owned by the
  unprivileged `node` user. Previously it mounted root-owned and room
  files silently failed to persist (EACCES, swallowed).
- Mobile match-strip poster used a raw `/api/poster/...` URL; it now
  goes through `posterSrc()` like every other poster (404'd under a
  reverse-proxy `rootPath` mount).

### Removed
- The 90-day room-retention path (`cleanupRooms`, `ROOM_RETENTION_DAYS`
  env var, `roomRetentionDays` config/YAML key, validation, and the
  unraid template field). It was dead: the 6h active-room TTL sweep
  always deleted rooms long before the 90-day cutoff could apply. The
  6h TTL sweep is now the sole room-expiry policy and also removes
  unreadable room files (previously `cleanupRooms`' job).

## [0.3.10] - 2026-05-18

### Fixed
- Match-view poster images broke under a reverse-proxy mount
  (`rootPath` / `X-Forwarded-Prefix`). `MatchesList`, `MatchMoment`,
  and the desktop match sidebar used raw `/api/poster/...` URLs while
  `Card` prefixed `rootPath`. All four now go through a shared
  `posterSrc` helper so the prefix is applied consistently.
- A reconnecting or rejoining user could appear twice in other
  clients' user lists -- the server re-broadcast `userJoinedRoom` and
  the reducer blind-appended. The `userJoinedRoom` case is now
  idempotent on `userName`.
- `leaveRoom`, `requestFilters`, and `requestFilterValues` could hang
  if invoked while the socket was reconnecting: they awaited a
  response but, unlike `login`/`joinRoom`/`createRoom`, did not first
  wait for an open socket, so the dropped send left the promise
  unresolved. They now `await waitForConnected()` first. This
  completes audit item B4 (0.3.7 fixed B3 only).
- Malformed WebSocket payloads no longer hang the client. A message
  like `{type:"login",payload:{}}` reached `sanitizeInput` with an
  undefined value, threw, and was swallowed by the catch-all with no
  reply. `handleLogin`, `handleCreateRoom`, `handleJoinRoom`, and
  `handleJoinOrCreateRoom` now validate the payload shape and answer
  with their respective error messages.

## [0.3.9] - 2026-05-18

### Fixed
- Docker `HEALTHCHECK` hardcoded port 8000; a container started with a
  custom `PORT` was marked unhealthy even though the app was fine. The
  healthcheck now reads `PORT` (default 8000). `EXPOSE` stays at 8000
  (image metadata only -- remap on the host side if `PORT` changes).

### Changed
- Renamed `validateConfig` to `normalizeAndValidateConfig`. The
  function normalizes its input in place (port/roomRetentionDays
  coercion, logLevel uppercasing) in addition to validating it; the
  old name hid a load-bearing mutation that `loadConfig` depends on.

### Security
- Documented that `getRootPath` trusts the `X-Forwarded-Prefix` header
  unconditionally by design -- consistent with the existing rateLimit
  proxy-trust caveat. The value is HTML-escaped and only affects the
  requesting client's own WS/poster URL prefix; no code change.

## [0.3.8] - 2026-05-18

### Fixed
- `Tr` translation interpolation rendered a missing context key as the
  literal string "undefined". A missing key now leaves the `${key}`
  placeholder visible instead. Latent only -- no current `<Tr>`
  callsite passes a `context`.

### Removed
- Dead `Client.finished` promise and `_finishedResolve` -- created and
  resolved on disconnect but never awaited anywhere.

### Changed
- `package.json` `engines` raises the pnpm floor from `>=9.0.0` to
  `>=10.0.0`, matching the Dockerfile pin (10.33.2), CI, and
  CONTRIBUTING.
- Added `.vscode/tasks.json` defining the `build:server` task that
  `launch.json`'s `preLaunchTask` references but never had a
  definition for.

## [0.3.7] - 2026-05-18

### Fixed
- `handleRequestFilters` had no error path: if `provider.getFilters()`
  threw, nothing was sent back and the frontend's `waitForAnyMessage`
  never resolved, leaving the FilterPanel stuck on "Loading filters..."
  forever. It now catches the failure and emits `requestFiltersError`,
  mirroring `handleRequestFilterValues`. The frontend reducer handles
  `requestFiltersError` by clearing the loading state and raising a
  "Couldn't load filters" toast.
- Swiping or tapping while disconnected called `ws.send()` on a closed
  socket, throwing synchronously and surfacing as an unhandled
  rejection. The frontend `sendMessage` now guards on socket state and
  drops the message with a console warning instead.

### Changed
- `PlexApi.getCapabilities()` now caches its response Promise (like
  `getServerId`), so every WebSocket connection's `getServerName()`
  call no longer fires a live Plex API request. Failures aren't
  cached, so a transient outage can still recover.
- The HTML template interpolation context no longer receives the full
  config object (which includes the Plex token); only `version` and
  `rootPath` are passed, the only values the shell references.
- `docker-compose.yml` commented basic-auth block folded into the
  existing `environment:`/`secrets:` keys -- uncommenting it verbatim
  previously produced duplicate YAML keys.


---

## Older entries (0.1.0 - 0.3.6)

The pre-audit-cycle changelog (the initial 0.1.x stabilization, the
0.2.x feature work, and the 0.3.0-0.3.6 releases) lives in
[`docs/CHANGELOG-archive.md`](./docs/CHANGELOG-archive.md). Split out in
0.4.7 to keep the active changelog readable.
## [0.3.6] - 2026-05-15

### Fixed
- Unraid template's Log Level description listed invalid values
  (`trace`, `warn`). A user who entered one would fail config
  validation and the container wouldn't start. Corrected to the
  accepted set: debug, info, warning, error, critical.
- `handleRate` now validates `rate.rating` is `like` or `dislike`
  before storing it, instead of trusting the client-asserted value.

### Removed
- Dead `key.includes('/')` branch in `PlexApi.getFilterValues` -- the
  only caller validates the key against `^[a-z0-9_-]+$`, so the key
  can never contain a slash.

### Changed
- Room-name input `maxLength` raised from 30 to 48 to match the
  server's `ROOM_NAME_MAX_LEN`.

## [0.3.5] - 2026-05-15

### Security
- Rate-limit inbound WebSocket messages per connection (fixed window,
  100 messages per 10s). HTTP routes were already per-IP rate-limited,
  but WebSocket messages were not -- a single connection could flood
  `handleRawMessage`, e.g. with repeated `createRoom`. Messages over
  the cap are dropped; the cap is well above rapid-swipe traffic.
- Cap the in-memory room registry at 500 rooms. `createRoom` now throws
  `RoomLimitError` when the cap is reached, bounding the memory/disk a
  flood of room creations can consume.

## [0.3.4] - 2026-05-15

### Removed
- Browser-based setup flow removed. The `setup` WebSocket message,
  `handleSetup`, and `updateConfiguration` are gone, so configuration
  can no longer be submitted from the browser -- a Plex server is
  supplied only via the `PLEX_URL` / `PLEX_TOKEN` environment variables
  (or `config.yaml`). This closes the unauthenticated-setup window an
  attacker could otherwise use on an unconfigured server. The config
  payload no longer ships `initialConfiguration` (the full server
  config, including the Plex token) to the browser.

### Changed
- When no Plex server is configured, the browser now shows a static
  "not set up" notice instead of an editable setup form, and the
  server logs an error naming the required environment variables.
  The container keeps running either way.

## [0.3.3] - 2026-05-15

### Security
- Fix a path-traversal flaw in `loadTranslation`: the `setLocale`
  WebSocket message (handled before any login check, and unauthenticated
  on the default no-Basic-Auth deployment) passed its `language` string
  straight into a `join()` file path. `join()` resolves `../`, so a
  crafted locale could read any `.json` file the process could reach --
  including persisted room files. Locale candidates are now validated
  against a strict tag pattern before `readFile`; anything that doesn't
  match is dropped and the safe `en` default is used. Adds regression
  tests for traversal payloads.

## [0.3.2] - 2026-05-15

### Removed
- Room password / passcode chain removed entirely. The feature had no
  way to set a password since the 0.2.0 login redesign dropped the
  password input, so it was dormant dead code. Gone: the `Room.password`
  field, its plaintext persistence in `data/rooms/*.json`, the HMAC
  constant-time join-check in `getRoom`, the `AccessDeniedError` join
  error, and the `?passcode=` share-link plumbing. Room files persisted
  by older versions still load fine -- a leftover `password` key in the
  JSON is simply ignored.

## [0.3.1] - 2026-05-15

### Changed
- Plex links collapse to a single "Open in Plex" link pointing at the
  app.plex.tv web player. The separate "Open in Plex app" (`plex://`)
  deep link was dropped after device testing on iOS and Android: it
  opens the Plex app but never navigates to the item -- the Plex apps
  don't route the `metadataKey`, regardless of scheme or key encoding.
  The web URL reliably lands on the movie page.

## [0.3.0] - 2026-05-15

First release since 0.1.7. Promotes the entire 0.2.0–0.2.23 dev line
to `main`: the login/branding redesign, an external security audit
and its follow-up hardening, and a seven-item feature roadmap.
Per-version detail is in the `0.2.x` entries below.

### Highlights
- **Login + branding redesign** (0.2.0): rebuilt login screen, the
  "reely" three-card mark, the Plex provider icon, regenerated app
  icons / manifest / favicon.
- **Filters**: instant-apply + toast replacing the propose/accept/
  reject voting flow (0.2.4); decade and other server-enumerated
  filters render as pills instead of free text (0.2.17); the panel
  pre-populates from the room's active filters (0.2.18).
- **Rooms**: single-message join-or-create (0.2.6); canonical +
  display room names with a character allowlist (0.2.19); a 6-hour
  inactivity TTL (0.2.20).
- **Plex links**: two per match — open in browser or open in the
  Plex app — built client-side, correct `metadataType` per content
  type (0.2.23).
- **Security hardening** from the 2026-05-12 external audit:
  enforced Content Security Policy (0.2.22); per-IP and per-room
  rate limits; path-traversal guards on media routes; bounded
  memoization caches; WebSocket pong-timeout + send-buffer
  backpressure; HMAC constant-time credential comparison
  (0.2.8–0.2.16).
- **Infra**: GitHub Actions on the Node 24 runtime (0.2.21); the
  Docker image runs as a non-root user with a HEALTHCHECK (0.2.15).
- Test suite expanded to 135 tests.

## [0.2.23] - 2026-05-14

Roadmap item #7: Plex deep links. Reworked from a single
server-resolved link into two user-facing choices built client-side.

### Added
- **Two "Open in Plex" links** on a match: **Open in browser**
  (`app.plex.tv` web player) and **Open in Plex app** (`plex://`
  native deep link). Both appear in the swipe-card more-info panel
  and the match-celebration overlay; the match list and desktop
  match sidebar keep a single click-to-open (web).
- `buildPlexLinks` util + `<PlexLinks>` component build the URLs
  client-side from the Plex server id and the media's raw key.
- `AppConfig.plexServerId` — the Plex machine identifier, surfaced
  to the frontend (not sensitive; it's in every Plex link anyway).
- `Media.plexKey` — the raw Plex metadata key, replacing the old
  `linkUrl` redirect-endpoint string.
- `getServerId()` on the `ReelyProvider` interface.

### Fixed
- **`metadataType` is now correct per content type** in the
  `plex://` deep link: `1` for movies, `2` for TV shows. The old
  server-side `getDeepLink` hardcoded `1`, so every show got a
  movie-typed deep link.

### Removed
- The server-side link-redirect machinery, now unused: the
  `/api/link/*` route + handler, `PlexApi.getDeepLink`,
  `provider.getCanonicalUrl`, `PlexDeepLinkOptions`,
  `defaultLinkTypeForUserAgent`.
- The `MOVIE_LINK_TYPE` env var / `linkType` server config field,
  its validation (`ServerLinkTypeInvalid`), the Config-screen form
  field, and the README row. Link behavior is no longer
  admin-configured — the user picks per click.
- Why direct links instead of the redirect: a `plex://` deep link
  is reliably triggered by a real user click on an `<a href>`, but
  a 302 redirect *to* `plex://` is dropped by several browsers.

### Notes / deferred
- **Android**: the app link uses the same `plex://preplay` URL as
  iOS as a first cut (the Plex Android app registers a `plex://`
  intent filter). If device testing shows it doesn't open, the
  fallback is `https://links.plex.tv/…` — an undocumented app-link
  format whose reverse-engineering is deferred.
- **iPhone without the Plex app**: `plex://` silently does nothing;
  the "Open in browser" button is the universal fallback.
- Flagged for future review: auto-detecting whether the client can
  reach the local Plex server, to toggle the browser link between
  `app.plex.tv` and the local `/web` UI.

## [0.2.22] - 2026-05-14

Roadmap item #5: Content Security Policy.

### Security
- **CSP is now enforced.** `helmet` was applied with
  `contentSecurityPolicy: false` since 0.1.0. It now ships an
  explicit directive set:
  - `script-src 'self'` — strict. The Vite bundle and the PWA
    `registerSW.js` are both self-hosted external files; the
    production build has no inline scripts, so no `'unsafe-inline'`
    or `'unsafe-eval'` is needed.
  - `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`
    — `'unsafe-inline'` covers React's `style={{…}}` attributes
    (inline styles aren't a meaningful XSS vector); the Google
    Fonts domain covers the webfont stylesheet.
  - `font-src 'self' https://fonts.gstatic.com` — the webfont files.
  - `connect-src 'self'` — same-origin WebSocket (`/api/ws`).
  - `img-src 'self' data:`, `worker-src`, `manifest-src`,
    `base-uri`, `form-action` all `'self'`; `object-src 'none'`;
    `frame-ancestors 'none'` (anti-clickjacking).
- **`useDefaults: false` is deliberate.** Helmet's default CSP
  includes `upgrade-insecure-requests`, which would force the
  browser to upgrade Reely's plain-`http://` LAN traffic to
  `https://` and break the entire app. The full directive set is
  spelled out so that directive is never emitted. Verified: the
  served `Content-Security-Policy` header contains no
  `upgrade-insecure-requests`.

### Notes
- CSP misconfiguration fails silently in subtle ways. The header
  was smoke-tested (server started, header inspected) but the full
  browser flow — page load, WebSocket connect, Google Fonts, swipe,
  match, filter panel — should be exercised with `pnpm serve` before
  this is considered done.
- Google Fonts are loaded from `fonts.googleapis.com` /
  `fonts.gstatic.com`. Self-hosting them would let `style-src` /
  `font-src` drop the external origins (and work offline); noted as
  a possible future tightening, out of scope here.

## [0.2.21] - 2026-05-14

Roadmap item #6: GitHub Actions Node 24 runtime migration.

### Changed
- **Bumped all GitHub Actions to versions that declare the `node24`
  runtime.** GitHub forces all JavaScript actions onto Node 24 on
  2026-06-02 and removes Node 20 from runners on 2026-09-16; actions
  still pinned to majors built for the `node20` runtime emit
  deprecation warnings and risk breakage. Updated:
  - `ci.yml` (all three jobs): `actions/checkout` v4 → v6,
    `pnpm/action-setup` v4 → v6, `actions/setup-node` v4 → v6.
  - `release.yaml`: `actions/checkout` v4 → v6,
    `docker/setup-qemu-action` v3 → v4,
    `docker/setup-buildx-action` v3 → v4,
    `docker/login-action` v3 → v4,
    `docker/build-push-action` v6 → v7,
    `softprops/action-gh-release` v2 → v3.
- The project's own CI Node version was already `"24"` (set since
  0.1.0); this change is purely about the action *runtime*, not the
  toolchain Node.

## [0.2.20] - 2026-05-14

Roadmap item #4: 6-hour active-room TTL. The login footer copy
("rooms expire 6h after last swipe") is now true. Closes audit
finding 2.19.

### Added
- **`Room.lastSwipeAt: number`** -- timestamp of the most recent
  rating, initialized to `createdAt` so brand-new rooms still start
  the clock. Updated on every successful `storeRating`.
- **`PersistedRoom.lastSwipeAt?: number`** -- round-tripped through
  save/load. Legacy persisted rooms (pre-0.2.20) without the field
  fall back to `updatedAt` -- close enough for TTL purposes.
- **`ROOM_TTL_MS` constant** in `roomStore.ts`: `6 * 60 * 60 * 1000`
  (6 hours).
- **`cleanupExpiredRooms(ttlMs)`** sweep in `roomStore.ts`. Two
  passes:
  1. In-memory: iterate `getAllRooms()`; rooms whose `lastSwipeAt`
     is older than `now - ttlMs` are removed from the registry and
     their on-disk file unlinked.
  2. On-disk: scan `data/rooms/*.json` for any persisted rooms not
     currently in memory whose effective last swipe (`lastSwipeAt
     ?? updatedAt`) is past the cutoff; unlink those files.
- **Scheduled in `app.ts`**: runs at startup (alongside the existing
  90-day retention sweep) and on a `setInterval` every 10 minutes.
  Cleared in `_shutdownFn`.
- **`getAllRooms()` and `removeRoom()` exported** from `room.ts` so
  the sweep can iterate the registry without piercing encapsulation.

### Tests
- 6 new cases covering `Room.lastSwipeAt` persistence, eviction of
  expired in-memory and on-disk rooms, retention of fresh rooms,
  and the pre-0.2.20 `updatedAt` fallback. 137 → 143.

### Operational notes
- The TTL is separate from the existing 90-day cold-storage
  retention (`cleanupRooms`). The two coexist.
- Users still in the room when TTL fires (genuinely 6h+ of no
  swipes by anyone) will find subsequent server operations fail
  against the now-gone room. Edge case; acceptable for the casual-
  app deployment model.
- Rooms created during a previous session that have no
  `lastSwipeAt` in their persisted file fall back to `updatedAt`,
  which `saveRoom` updates on every persistence. Practically:
  legacy rooms expire based on when they were last saved, not
  literally last swiped. Functional approximation.

## [0.2.19] - 2026-05-14

Roadmap item #3: room-name redesign.

### Changed
- **Room names now have two stored forms: canonical and display.**
  - **Canonical** (`Room.roomName`): lowercased, allowlist-stripped.
    Used as the Map key, the persistence filename, and the URL
    parameter value. Case-insensitive matching: "Movie Night",
    "movie night", and "MOVIE NIGHT" all resolve to the same room.
  - **Display** (`Room.displayName`): case preserved. Used in the UI
    so users see what they typed.
- **Allowlist:** letters, digits, spaces, and `! @ $ - _ '`. Rejects
  `# ? "` and other characters that break URLs or filesystems. Length
  capped at 48 characters server-side.
- **New helpers** `sanitizeRoomNameCanonical` and
  `sanitizeRoomNameDisplay` in `util/sanitize.ts` (and a frontend
  mirror for the Login input so what the user types onscreen matches
  what the server will store).
- **Share-link cosmetic polish:** apostrophes are no longer
  percent-encoded in the copied URL. `?roomName=bob's+room` instead
  of `?roomName=bob%27s+room`. Both forms parse identically server-
  side.
- **Frontend `room.displayName`** flows through the store from
  join/create success payloads. `Room.tsx` desktop top bar renders
  `displayName ?? name`.

### Protocol
- `CreateRoomRequest.displayName?: string` and
  `JoinRoomSuccess.displayName?: string` are new optional fields.
  Pre-0.2.19 servers/clients fall back to the canonical name for
  display.

### Tests
- 12 new cases for `sanitizeRoomNameCanonical` /
  `sanitizeRoomNameDisplay`: case preserve / lowercase, allowlist
  inclusion + exclusion, control byte / path-separator stripping,
  whitespace handling, length cap, all-invalid → empty. 125 → 137.

### Migration
- Existing rooms persisted before 0.2.19 may have mixed-case filenames
  in `data/rooms/`. Those become unreachable as the server canonicalizes
  inbound names to lowercase. They'll be cleaned up by the existing
  `cleanupRooms` retention sweep. Test rooms can be recreated.

## [0.2.18] - 2026-05-14

### Changed
- **FilterPanel pre-populates from `room.activeFilters` on open.**
  The panel used to start with an empty draft regardless of what
  filters were active, so the only signal of active filters was the
  count badge -- a solo user could "I applied filters, why does the
  panel look empty when I reopen it?" gap that the briefing called
  out. The panel now:
  - Lazy-initializes its draft from `room.activeFilters` on first
    mount.
  - Adds an `isOpen` prop; on every `false → true` transition it
    re-syncs the draft (and resets expanded-row state) from current
    `activeFilters`. Covers the desktop case where the panel is
    permanently mounted via CSS show/hide.
  - Prefetches `requestFilterValues` for each pre-populated key on
    mount, so collapsed row summaries show real value titles
    ("Drama, Action") instead of raw ids while the user scans.
  - In-progress edits are preserved while the panel is open --
    activeFilters changes mid-edit (e.g. another user applies
    filters) won't wipe the user's draft. The toast still
    informs them; the snap fires on next close + reopen.

## [0.2.17] - 2026-05-13

### Fixed
- **Decade filter (and any other Plex-enumerated integer field) now
  renders as pills instead of a free-text input.** The previous
  `FilterPanel` rendering branched on
  `fieldDef.type === "tag" || "string"`, which excluded `"integer"`
  even when the server returned a discrete value list (1900s, 1910s,
  ...). The decision now branches purely on whether the server
  returned enumerated values for the key:
  - `filterValues === undefined` -> "Loading values..." placeholder
    (request still in flight)
  - `filterValues.length > 0` -> pills, regardless of `fieldDef.type`
  - `filterValues.length === 0` -> free-text `SearchControl`
- `boolean` keeps its dedicated Yes/No path.

### Changed
- **Protocol: `requestFilterValuesError` payload now includes the
  failing `key`.** The reducer can now mark that specific key as
  resolved-with-no-values on error, so the UI drops the "Loading..."
  state and falls back to the free-text input. Previously the error
  payload was just `{ message }`, leaving the UI stuck.
- **Server: `getFilterValues` errors are now caught** in
  `handleRequestFilterValues` and logged with the failing key + the
  underlying error. Previously a throw from the provider would
  propagate up to the generic outer `try/catch` in `handleRawMessage`
  with no useful context.

## [0.2.16] - 2026-05-12

External-audit follow-up, test-coverage gaps. Adds 33 new tests
(92 → 125 total). Writing the i18n tests also surfaced a real bug
in the no-Accept-Language fallback path; fixed below.

### Added

Test coverage for previously-untested modules:

- **`tests/plex/util.test.ts`** — `filterToQueryString` operator
  variants (`=`, `!=`, `>=`, `<=`, `~=`, `>>=`) and value joining;
  `filtersToPlexQueryString` empty-input, mapping, and the
  `library`-key skip.
- **`tests/plex/api.test.ts`** — `defaultLinkTypeForUserAgent`
  picks `'app'` for iPhone UA, `'plexTv'` for desktop, Android,
  null, undefined, and empty UA.
- **`tests/middleware/rateLimit.test.ts`** — per-IP windowing,
  429 + `Retry-After` header on limit hit, bucket reset after
  `windowMs`, distinct-IP isolation, missing-IP fallback to
  `"unknown"`.
- **`tests/config/loadConfig.test.ts`** — env-only path produces
  defaults-filled config, env-over-yaml override, servers-array
  index merge, `/dev/null` sentinel skips file load, explicit
  missing path is fatal, default missing file is tolerated.
- **`tests/i18n/i18n.test.ts`** — exact-locale match, `en-US → en`
  fallback, q-weighted preference ordering, missing-header default,
  unknown-locale fallback. Uses the real
  `configs/localization/*.json` files (per-locale `FILTERS_LOADING`
  string as the discriminator).

### Fixed
- **`getTranslations` actually defaults to English when no
  Accept-Language header is sent.** The previous code logged
  "defaulting to en" but then fell through to `accepts()`, which
  with no header picks the first item from the offer list -- i.e.
  whatever locale `readdir()` returned first (often `de` on Linux,
  alphabetically). Surfaced by the new i18n test suite. Now
  short-circuits to `loadTranslation('en')` so the log and the
  behavior agree.

### Changed
- **`defaultLinkTypeForUserAgent` is now exported** from
  `providers/plex.ts`. Marked `// Exported for unit testing.`

## [0.2.15] - 2026-05-12

External-audit follow-up, cleanup + documentation batch.

### Fixed
- **`memo1` no longer caches rejected Promises forever.** Mirrors
  `memo1TTL`'s behavior: if the cached value is a rejecting Promise,
  the entry is removed so the next call retries the function.
  Previously, a one-time `loadTranslation('en')` failure would have
  served stale rejection for the lifetime of the process.
- **`memo1TTL` no longer evicts an unrelated entry when refreshing
  an existing key.** The size-cap check now skips when the key is
  already present, since the subsequent `.set()` replaces in place.
- **`createStore.ts` dispatch routing uses an explicit allowlist.**
  Replaced `if (action.type in client)` (which matched inherited
  `EventTarget` methods like `addEventListener`) with a `Set<ServerMessage["type"]>`.
- **Viewport no longer disables zoom.** Dropped `user-scalable=no`
  from the viewport meta. Accessibility regression closed.

### Changed
- **`Room.RouteContext` → `Room.routeContext`.** PascalCase field
  name was an accidental match for the type name; aligned with the
  rest of the codebase's camelCase fields.
- **Plex link-type default extracted into `defaultLinkTypeForUserAgent`.**
  The "iPhone → app, else web" heuristic was buried in a switch
  default. Lifted to a named module-scope helper so it's easier to
  find and extend (iPad, Android, etc.).
- **Dockerfile drops root.** Adds `RUN chown -R node:node /app` and
  `USER node` before `ENTRYPOINT`. Reduces blast radius if the
  process is compromised.
- **Dockerfile gains a HEALTHCHECK** hitting `/health` every 30s
  via `node -e` (wget/curl aren't in `node:24-slim`).
  Docker / Unraid will now report container health instead of
  "starting" indefinitely.

### Documentation
- **`memo.ts`** docstrings now spell out: `memo()` caches the first
  call's result regardless of args (single-shot init); failure-not-cached
  behavior for `memo1` + `memo1TTL`; the dev/prod caching dichotomy.
- **`Room` public fields** (`password`, `users`) carry comments
  explaining their external-mutation contract.
- **`config/main.ts`** clarifies the `configPath` consistency
  contract and makes the `/dev/null` sentinel discoverable.
- **`logger.ts`** explains why `applyRedactions` runs eagerly
  (irrespective of level) and why `redactions` isn't pruned across
  config reloads.
- **CardStack reducer** carries a comment noting the deliberate
  impurity (kicks off spring animations) so a future contributor
  doesn't "fix" it by hoisting state out.

## [0.2.14] - 2026-05-12

External-audit follow-up, correctness mid-tier.

### Fixed
- **Filter operator regex no longer accepts bare `<` / `>` / `~`.**
  `filterToQueryString` strips the trailing `=` before appending the
  operator to the key (so `genre!=` becomes `genre!`). A single `<`
  would have its only character stripped, corrupting the query to a
  plain equality. Tightened `isValidFilter` to require the operator
  to end in `=`: `/^[!<>=~]{0,2}=$/`. All real Plex operators
  (`=`, `!=`, `>=`, `<=`, `~=`, `>>=`, `<<=`) still pass.
- **CardStack no longer allocates throwaway Controllers each render.**
  `useReducer`'s second-arg initial-state was evaluated on every
  render, spawning `INITIAL_COUNT` fresh `Controller<Spring>`
  instances each time even though React only used them on first
  mount. Switched to the third-arg lazy initializer form.
- **Typed startup errors now reach `main.ts`.** The `Application`
  IIFE used to swallow every error into `resolveStatus(1)`, making
  the `catch (err) { if (err instanceof ProviderUnavailableError) … }`
  branches in `main.ts` unreachable. Now those errors reject the
  `statusCode` promise so `main.ts` can log them with the right
  specificity and decide whether to re-loop on
  `ConfigReloadError`.
- **`getVersion` no longer reads from disk on every page render.**
  The template handler used to `await getVersion()` per request.
  `VERSION` doesn't change at runtime. Memoized.
- **`PORT=abc` fails at startup instead of becoming `NaN`.**
  `getTrimmedEnv(..., Number)` returned `NaN` for non-numeric env
  values, which then spread into the merged config and overrode the
  default port. Numeric env coercion now throws a clear error
  naming the offending key and value.
- **Match-celebration copy no longer lies about who likes the movie.**
  `MatchMoment` said "Everyone in the room loves this one" but the
  match trigger is `likes.length > 1`. In a 3-person room with 2
  likes that was overstated. Now reads "You both like this one" /
  "N of you like this one" based on `match.users.length`.
- **Dropped `srcSet` variants on swipe-card posters.** Card.tsx
  requested `?width=300/450/600/900` but the poster handler ignored
  the param and Plex always returned full-size, so the browser was
  fetching the same image 4 times. Single `src`. Real Plex
  transcoding can come back if needed.
- **Share-link `?passcode=` is now actually used.** `Login.tsx`
  reads the URL param and includes it in the `joinOrCreateRoom`
  dispatch; the auto-rejoin path in `createStore.ts` does the same.
  Previously the share button set the passcode in the URL but
  nothing parsed it on the receiving side, so recipients couldn't
  join a passworded room without typing it manually (and there's no
  password input on the login screen since the 0.2.0 redesign).
- **`dist/web/index.html` rebuilt to pick up `lang="en"`.** The
  source `<html lang="en">` change from 0.2.3 was correct, but a
  stale build artifact still had `${LANG}` which then interpolated
  to empty string at runtime. Rebuilding closes this; Docker
  production builds always rebuild from source so this only
  affected stale local working copies.

## [0.2.13] - 2026-05-12

External-audit follow-up, dead-code purge.

### Removed
- **`parseXML` and the `sax` dependency.** `internal/app/plex/util.ts`
  shipped a streaming XML parser that no caller used (Plex responses
  are requested with `accept: application/json` and parsed via
  `JSON.parse`). Dropped the function, the `XMLNode` / reviver types,
  the `sax` runtime dep, and the `@types/sax` dev dep.
- **Four unused Plex type files.** `library_item_artist.ts`,
  `library_item_movie.ts`, `library_item_show.ts`, and `users.ts` had
  no imports anywhere in the codebase.
- **`PlexTranscodeOptions`** interface in `plex/api.ts` — declared,
  never referenced.
- **`RoomInfoBar` component** (88 lines + CSS module) — defined but
  imported nowhere.
- **`/poster` Vite dev proxy rule.** Already covered by the `/api`
  proxy directly above it; the actual path is `/api/poster/...`.
- **`SESSION_SECRET`** entry from `.env.example`. No code reads it.
  (Local `.env` files are untouched.)
- **`RoomOption`, `RoomSort`, `Permissions`** union types and the
  fields that carried them: `Room.options`, `CreateRoomRequest.options`,
  `CreateRoomRequest.sort`, and `User.permissions`. None were read
  anywhere; the `permissions: []` assigned in `loginSuccess` was
  empty boilerplate. Persisted-room JSON loses one field
  (`PersistedRoom.options`) -- any existing files with that key will
  just have the extra ignored by `JSON.parse`.
- **`ReelyProviderCtor`** type — unused.

### Changed
- **Stale "MovieMatch" references in `providers/types.ts`** updated
  to "Reely" and the comment cleaned up.

## [0.2.12] - 2026-05-12

External-audit follow-up, server-hardening batch.

### Fixed
- **Shutdown no longer hangs on open WS clients.** `wss.close()` only
  stops accepting new sockets; existing connections kept
  `httpServer.close()` blocked indefinitely. The shutdown function
  now iterates `wss.clients` and `ws.terminate()`s each before
  closing the server. Matters for config-reload-driven restarts.
- **`waitForMessage` listeners no longer leak across reconnects.**
  The `Promise.race([waitForMessage(success), waitForMessage(error)])`
  pattern left the unfired `{once: true}` listener attached forever,
  accumulating with each WS reconnect and capable of firing on later
  unrelated messages. New `waitForAnyMessage` helper races multiple
  types with shared cleanup; all client-side request methods (login,
  joinRoom, joinOrCreateRoom, leaveRoom, createRoom, requestFilters,
  requestFilterValues, setup, logout) now use it.
- **`interpolate` ignores `$&` / `$1` back-references.** Both
  `template.ts` and `Tr.tsx` passed the raw value to
  `String.prototype.replace`, which interprets `$&` as the matched
  substring. A translation or template value containing `$&` would
  otherwise expand back to the placeholder. Switched to the
  function-replacer form.
- **`loadFromYaml` no longer masks non-ENOENT errors.** The previous
  catch turned every `readFile` failure into `ConfigFileNotFoundError`,
  including `EACCES` / `EISDIR` / `EIO` — the opposite of what the
  comment claimed. Now only ENOENT becomes the typed error; other I/O
  errors propagate so operators see the real cause in the Unraid log.

### Changed
- **`PlexApi.getServerId` is memoized per instance.** The Plex server
  identifier is immutable for a given server; every previous link
  click triggered a fresh `/identity` fetch. Caches the Promise so
  concurrent first-callers coalesce into one request; failures are
  not cached.
- **Constant-time credential compare via HMAC.** Both the Basic Auth
  middleware and the room password check used
  `expected.length === actual.length && timingSafeEqual(...)`. The
  early length check leaked length via timing. Hashing both sides to
  fixed-length SHA-256 digests first eliminates the length channel.
  The HMAC key isn't a secret -- it just has to be the same for both
  sides of one comparison.

## [0.2.11] - 2026-05-12

External-audit follow-up: closes seven items flagged in the
2026-05-12 audit. Three of these were regressions from 0.2.6–0.2.9.

### Fixed
- **Toast id no longer throws on plain HTTP.** `crypto.randomUUID()`
  requires a secure context; Reely's intended LAN deployment is plain
  `http://`, so the first remote `filterChangeApplied` was TypeError-ing.
  Replaced with a session-scoped counter + random suffix. (Regression
  from 0.2.9.)
- **Rules of Hooks violation in `RoomScreen`.** `useMemo` for the
  sorted matches sat *after* the `if (!room) return …` early return,
  so hook count varied across `room` toggling defined/undefined and
  React would eventually throw. Hoisted the `useMemo` above the
  early return, with `room?.matches` guards inside.
- **Login `pendingJoin` no longer gets stuck after a login error.**
  Added an effect that clears the deferred-join ref on any `error`,
  so a later auto-set of `user` (e.g., WS reconnect with stored
  session) can't silently fire a stale `joinOrCreateRoom`. (Regression
  from the 0.2.6 join-or-create refactor.)
- **`applyFilters` cooldown is now per-room, not per-Client.** The
  3-second throttle was an instance field on `Client`, so two browser
  windows for the same user (or two different users) could hammer
  the same room every 1.5s. Moved to `Room.lastApplyAt`. (Incomplete
  fix from 0.2.8.)
- **`Avatar` no longer overflows hue or collides SVG ids.** The hue
  hash used `charCodeAt ** (i+1)` which overflowed to Infinity for
  ~25-char names and produced `NaN` after the modulo. Replaced with
  a linear hash. SVG `<mask>` / image ids switched from
  `Date.now()`-derived strings (which collided when two Avatars
  rendered in the same millisecond) to `React.useId()`.
- **`handleLogout` now notifies the rest of the room.** Logging out
  used to silently evict the user from `room.users` without calling
  `notifyLeave`, so other clients kept showing the logged-out user
  in the avatar stack until they themselves reconnected.
- **No more "tried to send to a disconnected client" warning on
  every clean disconnect.** Extracted `leaveRoomCleanup()` from
  `handleLeaveRoom`. `handleClose` now uses the cleanup-only path
  instead of trying to emit `leaveRoomSuccess` to the just-closed
  socket.

## [0.2.10] - 2026-05-11

### Added
- **`SECRETS_DIR` env override.** Docker Compose and Swarm mount secrets
  under `/run/secrets`; some Kubernetes setups use `/var/run/secrets` or
  a custom path. `readDockerSecret` now honors `SECRETS_DIR` when set,
  so the same image works across orchestrators.
- **Exposure warning at server start.** When the server binds to
  `0.0.0.0` / `::` / empty hostname *and* Basic Auth is not
  configured, startup logs a clear warning that the app is reachable
  to anyone who can route to the host. Visible in the Unraid Docker
  log so admins can spot misconfigurations.
- **`joinRoomSuccess` / `createRoomSuccess` now include `roomName`.**
  The client adopts the server-sanitized canonical name on success
  rather than keeping the user-typed (locally-trimmed) version,
  eliminating the URL-bar / server-state divergence. Optional in the
  protocol for backward-compat.

### Changed
- **WebSocket send-buffer backpressure.** `Client.sendMessage` now
  terminates the socket when `bufferedAmount` exceeds 4 MB. Stuck
  clients reconnect via the existing auto-reconnect path and re-sync
  state, rather than letting the server-side buffer grow without
  bound.

### Tests
- **Coverage for `isValidFilter` bounds:** key length, value array
  length, individual value length, operator regex, null payload,
  non-array filters.
- **Coverage for `joinOrCreateRoom` routing:** join path when the
  room exists, create path when it doesn't, retry-as-join when the
  create branch loses a `RoomExistsError` race. Adds a partial mock
  of `room.ts` that preserves the error classes via
  `vi.importActual`. Test count 82 → 92.

## [0.2.9] - 2026-05-11

### Fixed
- **Toast IDs are now collision-free** (`crypto.randomUUID()` instead
  of `Date.now()`-based strings). Multiple filter applies in the same
  millisecond no longer produce duplicate React keys.
- **`ToastList` no longer leaks redundant timers.** Each toast with a
  `showTimeMs` now gets exactly one removal timer, tracked in a ref
  and cleared on unmount. Previously every render of the toast array
  spawned a fresh `setTimeout` for the first toast.
- **`applyFilters` payload shape is validated up front.** A malformed
  WS message like `{ type: "applyFilters", payload: null }` now
  produces a logged warning instead of a silently-swallowed TypeError
  from the outer try/catch.
- **`createRoom` race-overwrite fixed.** Two concurrent `createRoom`
  calls for the same name could both pass the initial `has()` check
  (each yields on the initial media fetch before setting), and the
  later writer would silently overwrite the earlier room's Map
  entry. There is now a post-await re-check that turns the loser
  into a clean `RoomExistsError`.
- **`joinOrCreateRoom` retries as join on race.** If the create
  branch loses the post-fix `RoomExistsError` race (extremely rare),
  the handler now retries as a join instead of surfacing a confusing
  create error to the user.

### Changed
- **Filter validation tightened.** `isValidFilter` now caps key
  length (64), value array length (32), and individual value string
  length (128), and requires both the key and at least one value to
  be non-empty. The UI already enforced non-empty values; this closes
  the gap for direct WS injection.
- **Join/create handlers refactored to sanitize-once.** Extracted
  `createRoomFromSanitized` and `joinRoomFromSanitized` inner methods
  that assume their input has already been sanitized.
  `handleJoinOrCreateRoom` sanitizes the request once and calls the
  inner methods directly; the public `handleJoinRoom`/`handleCreateRoom`
  wrappers handle the sanitize + error-emit boundary. No more
  redundant sanitization on the join-or-create path.
- **`index.html` is now served with `Cache-Control: no-cache`.** The
  HTML shell references hashed asset filenames -- forcing the entry
  point to revalidate prevents browsers from serving a stale shell
  that points at deleted assets after a deploy.

## [0.2.8] - 2026-05-11

### Security / robustness

- **Path-traversal validation on poster + link routes.** `/api/poster`
  rejects non-numeric `metadataId` and `thumbId` (Plex ids are always
  integers). `/api/link` now requires the key to start with `/library/`
  and rejects `..` segments and control characters. Closes the
  URL-pathname-normalization vector where a crafted request could
  traverse to a different Plex API endpoint.
- **Per-IP rate limiting** on `/health` (60/min), `/api/poster`
  (600/min), `/api/link` (60/min), and the template handler (60/min).
  Lightweight inline middleware, no new dep. FIFO eviction caps the
  bucket cache at 2048 entries so distinct-IP floods can't exhaust
  memory.
- **Per-client `applyFilters` cooldown** of 3s. Each apply triggers a
  Plex media fetch + WS broadcast; without a cooldown a single bad
  client can saturate the room.
- **Bounded memoization caches.** `memo1` and `memo1TTL` in
  `util/memo.ts` are now capped (default 64 entries) with FIFO
  eviction. Closes the `loadTranslation`/`Accept-Language` flood
  vector and the analogous `getMediaCached`/filter-signature flood.
- **Unique tmp filename in `saveRoom`.** `${target}.tmp` is now
  `${target}.${pid}.${random}.tmp` so concurrent saves of the same
  room can't write to the same tmp path and race on rename.
- **WebSocket pong-timeout.** The 30s keepalive ping now tracks
  liveness via `ws.isAlive`. Zombie connections that miss a pong
  cycle get `terminate()`d on the next interval instead of lingering
  until the OS TCP timeout expires.

## [0.2.7] - 2026-05-11

### Fixed
- **Matches and progress no longer reset when a filter is applied.**
  `Room.applyFilters` previously wiped `ratings` and `userProgress` on
  the server, which meant matches the room had already found would
  silently disappear after any filter change. Both are now preserved:
  already-rated media still won't reappear in the swipe queue (the
  existing `getMediaForUser` filter handles that), but matches stay as
  shared history, progress rings stay accurate, and the client and
  server are in sync.
- **`/api/link/*` no longer crashes silently on Plex errors.** The link
  handler now wraps `getCanonicalUrl` in a try/catch, logs the
  provider index, key, and user agent, and returns a 502 with a
  user-readable message. Admins running on Unraid will now see actual
  failure context in the Docker log instead of a stack trace from
  Express's default error handler.
- **Toasts on remote filter applies now show field titles.** The
  `filterChangeApplied` toast resolves filter names from
  `createRoom.availableFilters`, which used to only load when the user
  opened the FilterPanel. `RoomScreen` now requests the filter catalog
  on mount, so users who never open the panel still see
  "Bob applied filters: Genre, Year" instead of "Bob applied filters:
  genre, year".

### Changed
- **`cleanupRooms` now logs the parse error** when removing unreadable
  room files, instead of just noting that something was unreadable.
  Helpful when diagnosing corruption from Unraid logs.

## [0.2.6] - 2026-05-11

### Changed
- **Single-message join-or-create:** The "start screening" button and the
  soft-refresh auto-rejoin both dispatch a new `joinOrCreateRoom`
  ServerMessage. The server probes the room index (memory + disk),
  routes to the join path if it exists or the create path if it
  doesn't, and emits the existing `joinRoomSuccess` /
  `createRoomSuccess` accordingly. One round-trip instead of two; no
  swallowed `RoomNotFoundError` flash.
- **Frontend cleanup:** `Login.tsx` drops the `autoCreate` ref and the
  error-watching `useEffect` that converted `RoomNotFoundError` into a
  follow-up `createRoom` dispatch. `createStore.ts` drops the
  `autoJoining` flag and its companion fallback block. Both paths now
  rely entirely on the server to decide.

## [0.2.5] - 2026-05-11

### Changed
- **Tightened `ProviderType` to a union.** `AppConfig.providerType` and
  `ReelyProvider.type` are now `'plex'` (a string-literal union) instead
  of free-form `string`. Adding a new provider (Emby, Jellyfin, …) now
  forces a deliberate union extension and a matching `ProviderIcon`
  case. `ProviderIcon` itself still accepts `string` so it can render
  unknown-type fallbacks without type churn.

## [0.2.4] - 2026-05-11

### Changed
- **Filter voting replaced with instant-apply + notification.** Applying
  filters from the panel now takes effect for everyone in the room
  immediately. Other users get a toast: "{user} applied filters:
  {field titles}". The proposer-waiting card, the approve/reject card,
  and the floating proposal banner are gone.
- **Filter panel CTA:** "Propose to room" → "Apply filters". Footer hint
  copy updated accordingly.

### Removed
- **Protocol:** `proposeFilterChange`, `acceptFilterChange`,
  `rejectFilterChange` ServerMessages. `filterChangeProposal` and
  `filterChangeRejected` ClientMessages. Replaced by a single
  `applyFilters` ServerMessage; `filterChangeApplied` payload gains an
  `appliedBy: string` field.
- **Server:** `Room.pendingFilterChange`, `notifyFilterProposal`,
  `notifyFilterRejected`. `Client.handleAcceptFilterChange` and
  `Client.handleRejectFilterChange`.
- **Frontend:** `FilterProposalBanner.tsx` and its CSS module deleted.
  `room.pendingFilterProposal` store field removed. `Room.tsx` no
  longer tracks `isProposer` or `pendingProposal`. `FilterPanel.tsx`
  drops `isProposer` + `onCancelProposal` props and the two proposal
  cards.

## [0.2.3] - 2026-05-11

### Changed
- **Login UX polish:**
  - The username field auto-focuses on first load when no name is stored,
    so the mobile keyboard appears without an extra tap.
  - The chip → edit transition (clicking "Change") now uses a layout
    effect to focus and select the field, eliminating the visible flash
    from the prior `setTimeout(0)` pattern.
  - Pressing ESC while editing the username restores the previous value
    and collapses back to the chip.
  - The server chip in the top-right fades in once server info arrives
    over WS, instead of popping in instantly.
  - Internal: `userName.trim()` / `roomName.trim()` are computed once per
    render instead of at each use site.

### Removed
- **22 unused translation keys** purged from `TranslationKey` and every
  locale JSON file (`en`, `de`, `es`, `fr`, `nl`, `pl`). The only
  remaining keys are `FILTERS_LOADING` and `RATE_SECTION_EXHAUSTED_CARDS`
  — the two actually rendered via `<Tr>`. `FIELD_REQUIRED_ERROR` was the
  last raw-access user; replaced with a hardcoded English "Required" to
  match the rest of the Login screen.
- **`${LANG}` template variable** dropped from `index.html` (now
  hardcoded `lang="en"` since the UI is English-only) and from the Vite
  dev-server substitution.

## [0.2.2] - 2026-05-11

### Fixed
- **Duplicate filter values:** Content rating, genre, and other multi-library
  filters no longer show duplicate pills (e.g., two "PG-13" entries). Plex
  returns per-library scoped keys for the same value; dedup now keys on the
  display title.
- **Login input sanitization:** Username and room name inputs strip the same
  characters the server rejects (control bytes, path separators, `..`
  sequences) as the user types, so what's shown locally matches what the
  server stores. Closes a divergence with browser-autofill values.
- **Unraid Docker icon:** Embedded the icon as a base64 data URI in the
  `net.unraid.docker.icon` label so Unraid resolves it without depending
  on a public repo URL.
- **Manifest icon `purpose`:** Dropped `maskable` from the PWA icon manifest
  entries (left as `any` only) since the current icon doesn't observe a
  maskable safe zone. Prevents potential clipping on Android adaptive
  launchers.

### Changed
- **`api.ts:getFilterValues` refactor:** Removed non-null assertions on the
  merged-loop result by seeding from the first library's response and
  appending the rest. Same behavior, cleaner types.

## [0.2.1] - 2026-05-11

### Changed
- **Server status dot:** The dot in the login server chip now reflects
  WebSocket connection state — green when connected, amber pulsing when
  connecting, pink when disconnected. Previously hard-coded green.

### Fixed
- **Logo font fallback:** The "r" in the SVG mark falls back to Times New
  Roman, then a system serif, if Instrument Serif hasn't loaded from
  Google Fonts yet.
- **Dead code in Login:** Removed an unreachable "create" branch in the
  post-login effect; auto-create has only ever gone through the error
  handler.

## [0.2.0] - 2026-05-10

### Added
- **`pnpm serve` script** and `.env.example`: builds the project and runs
  the server with env vars loaded from `.env` (Node `--env-file`), so
  local dev is a single command. `.env` is gitignored.

### Changed
- **Login screen redesign:** Full visual overhaul of the login screen.
  - New layout: Reely mark + wordmark top-left; server chip (Plex logo on
    black, server name, live dot) top-right. Content bottom-justified
    with flex spacer pushing the form down.
  - **Headline:** "pick tonight's screening." in Instrument Serif italic
    (56px).
  - **Subline:** "pick a room. anyone with the room name joins you."
  - **Username field:** Collapses to a pill chip (gradient avatar + name + "Change" affordance)
    when a name is stored. Clicking the chip or blurring an empty input returns to edit mode.
  - **Room name field:** Hero-sized serif italic input with `#` prefix. Gradient border appears
    on focus via CSS mask trick; 1px `--line` border at rest.
  - **Button:** "start screening →" pill, full gradient background. Disabled state at 0.45
    opacity with `not-allowed` cursor.
  - **Footer:** "rooms expire 6h after last swipe" in Geist Mono uppercase.
  - Passcode field removed.
- **Logo mark:** Updated to three-card stack SVG (back `#3a2118`, mid `#62342a`, front gradient)
  with italic "r" in Instrument Serif. Wordmark updated to lowercase "reely".
- **Server name in config:** Backend now fetches the Plex server's friendly name and includes
  it as `serverName` in the initial `config` message. `AppConfig` gains an optional
  `serverName` field; `sendConfig()` is now async.
- **Viewport meta:** Added `interactive-widget=resizes-content` to prevent the mobile keyboard
  from overlapping form fields.
- **App icon / favicon:** New icon using the three-card stack mark on a black rounded-square
  background. Replaces the old MovieMatch "M" mark. All PNG sizes (32, 180, 192, 512) and
  `favicon.ico` regenerated. Manifest and meta theme-color updated to match dark palette.
- **Page title:** Lowercased to "reely" for brand consistency.
- **Provider icon:** Plex server chip now shows a black circle with amber Plex chevrons instead
  of white-on-amber (better contrast). Provider type flows through `AppConfig.providerType`
  so future Emby/Jellyfin providers only need to set `type` on their provider object.
- **Docker:** Added `net.unraid.docker.icon` and `org.opencontainers.image.title/description`
  labels to the production image so Unraid and container registries display the correct icon
  and metadata. Icon URL resolves once the GitHub repo is public (or substitute any public URL).
- **Filter panel Apply button:** Text-input filters (year, free-text) now have an Apply
  button to the right of the input. Pressing Enter still works; the button helps on mobile
  keyboards that lack Enter.

## [0.1.7] - 2026-05-10

### Added
- **Leave room button:** Tapping your own avatar in the top bar opens a small popover
  with a "Leave room" option. Dispatches `leaveRoom`, clears the room from state, removes
  `?roomName` from the URL, and returns to the login screen. Username is preserved in
  localStorage so rejoining or entering a new room doesn't require retyping your name.

## [0.1.6] - 2026-05-10

### Fixed
- **Avatar red dot:** Progress ring no longer renders at 0%, eliminating the red dot
  visible on avatars before any swiping begins.
- **Username field locked on login:** Returning to the login screen with a stale session
  (e.g. after removing the room name from the URL) no longer locks the "Your name" field.
  The field is only disabled while actively mid-reconnect inside a room.
- **Match toast position:** Small match notification toast repositioned from mid-screen
  to just below the top bar (mobile: 54px, desktop: 8px), keeping it out of the way of
  the poster.
- **Duplicate matches label removed:** Desktop sidebar no longer shows a redundant
  "Movies you all love" subtitle above the match list.

### Changed
- **Filter proposal banner timeout:** Auto-dismiss extended from 5 seconds to 10 seconds.
- **Match toast auto-dismiss:** Toast now auto-dismisses after 3 seconds. The full-screen
  first-match celebration overlay remains manual dismiss.
- **Room name label:** Login form field label changed from "Room code" to "Room name".
- **Matches copy:** "Movies you all loved" corrected to present tense: "Movies you all love".
- **Esc closes filter drawer:** Pressing Escape on desktop closes the filter drawer.

## [0.1.5] - 2026-05-09

### Changed
- **Filter proposal banner position:** Banner now appears just below the top bar on both
  mobile (~54px from top) and desktop (8px from top of swipe stage) instead of overlaying
  the center of the poster.
- **Filter proposal banner timeout:** Banner auto-dismisses after 5 seconds on both mobile
  and desktop. The proposal remains accessible via the filter panel. Timer resets if a new
  proposal arrives.

## [0.1.4] - 2026-05-09

### Added
- **WebSocket keepalive ping:** Server pings all connected clients every 30 seconds so
  reverse proxies (nginx, Caddy, etc.) do not close idle WebSocket connections. Fixes
  sessions timing out after ~1-2 minutes of inactivity behind a proxy.

### Fixed
- **"Room does not exist" error flash on join:** When joining a room that does not exist
  the app auto-creates it, but the error briefly appeared before the room loaded. Fixed by
  clearing `error` state when any `joinRoom` or `createRoom` action is dispatched.

## [0.1.3] - 2026-05-09

### Added
- **Filter proposal in filter panel:** When a filter change has been proposed, the proposal
  card (with proposer name, filter chips, and Approve/Reject buttons) now appears at the top
  of the filter panel body on both mobile and desktop. Previously the proposal was only
  visible as a floating overlay that would not reappear after a reconnect.
- **Proposer waiting state in filter panel:** The "Waiting for everyone to vote…" / Cancel
  card is also shown at the top of the filter panel for the user who proposed the change.

### Changed
- **Desktop card size:** Cards now scale with viewport height (~75% of vh) and available
  stage width, approximately 40% larger than before on typical desktop resolutions.
- **Card height formula fallback:** `var(--vh, 1vh)` used throughout so cards size correctly
  even if the JS viewport-height correction has not fired yet.

### Fixed
- **Desktop filter drawer z-index:** The filter drawer now renders above the floating
  proposal banner instead of below it.

## [0.1.2] - 2026-05-09

### Added
- **Mobile match strip:** Horizontal scrolling row of poster thumbnails appears below the
  action buttons when matches exist. Tapping any poster opens the full match list.
- **Mobile top bar:** Reely logo (left) and avatar stack with swiping count (right) now
  anchor the top of the room screen on mobile, giving cards more breathing room.

### Changed
- **Mobile card size:** Removed the 420px height cap so cards scale to the device's screen
  width and viewport height instead of being fixed at 280×420 on phones.
- **Mobile action buttons:** Share (left) and Filter (right) replaced the combined info
  strip. Both buttons are 20% larger for easier tapping. The avatar group moved to the new
  top bar.

### Fixed
- **"Room does not exist" error on soft refresh:** When a page reload auto-rejoins a room
  that has since expired on the server, the app now silently creates a fresh room instead of
  landing back on the login screen with an error.

## [0.1.1] - 2026-05-09

### Fixed
- **Missing localization files in Docker image:** The production image stage did not copy
  `configs/localization/` from the builder, causing the container to crash on the first
  browser request with `ENOENT: no such file or directory, scandir '/app/configs/localization'`.
- **Bare PLEX_URL crashes container:** If `PLEX_URL` was set without the `http://` protocol
  prefix (e.g. `192.168.1.15:32400`), config validation failed and the container exited with
  no browser-visible error. The value is now automatically normalized -- `http://` is prepended
  when no protocol is present.
- **Unhelpful URL validation error:** The `ServerUrlInvalid` config error now includes the
  offending value and a suggestion to add the protocol, making the fatal log actionable.

## [0.1.0] - 2026-04-28

### Added
- **In-room collaborative filter changes (Phase 3, Bucket B):** One user proposes a filter
  change; all other users receive a notification showing the proposed filters and can accept
  or reject. Filters apply simultaneously for all users when accepted. In a solo room, filters
  apply immediately without a proposal step.
- **Active filter display:** A filter bar in the room shows which filters are currently active
  with human-readable names. Filter value labels are resolved automatically via the Plex API.
- **Filter proposal detail:** The proposal banner shows the proposed filter chips (e.g.
  "Genre: Action, Drama") so users can make an informed accept/reject decision.
- **Combined login screen (Phase 3, Bucket A):** Username, room name, and passcode are entered
  on a single screen with side-by-side Join and Create buttons. Filters moved out of room
  creation into the in-room Filters panel.
- **Docker secrets support:** `PLEX_TOKEN` and `AUTH_PASS` can be supplied as Docker secret
  files at `/run/secrets/<name>` instead of environment variables, keeping sensitive values
  out of `docker inspect` output and process listings.
- **`docker-compose.yml`:** Reference deployment configuration using Docker secrets.
- **Server layer (Phase 1b):** Full server-side migration from Deno to Node.js/Express.
  Includes: logger (`pino`), config loader (`js-yaml`), Plex API client (`sax` XML parser),
  all HTTP route handlers, i18n (`accepts`), WebSocket room/client logic (`ws`), and the
  main application entry point (`minimist`).
- **XML parser:** Replaced Deno's `deno.land/x/xmlp` `XMLPullParser` with `sax` (streaming
  parser). Tracks element depth to preserve the root-as-object / children-as-array structure
  required by the Plex API type definitions.
- **`memo` / `memo1` utilities:** Memoization helpers ported from Deno std. Used for
  localization file loading and Plex XML response caching.

### Changed
- **Runtime:** Migrated from Deno to Node.js (v24). Node.js was selected over Deno 2.x and
  Bun for contributor familiarity and the breadth of the npm ecosystem.
- **Package manager:** Adopted pnpm v10 with workspaces. The repo root is the server package;
  `web/app` is the frontend workspace.
- **Bundler:** Replaced Snowpack with Vite 6. Fast HMR in development, native API/WebSocket
  proxying, and optimized production builds.
- **React:** Upgraded from 17 to 18, enabling concurrent rendering and the new JSX transform.
- **TypeScript:** Upgraded from 4 to 5 in both server and frontend configurations.
- **Gesture library:** Replaced unmaintained `react-use-gesture` with `@use-gesture/react`.
- **State management:** Replaced Redux with Zustand.
- **Version series:** Versioned independently from the upstream project, starting at 0.1.0.
- **Filters:** Configurable from inside the room only (not at room creation time).
- **Match list:** Sort controls removed; matches always display most recent first.

### Fixed
- Card X/Heart buttons rated the wrong card (backmost instead of frontmost in the stack).
- Library filter was never applied when a Plex server had multiple libraries.
- Room join failed with "filters is not iterable" when joining a room that already had
  active filters set.
- Room error message now reads `The room "name" does not exist.` instead of a bare username.
- Page refresh after server restart no longer shows a pulsing error state; the app returns
  to the login screen correctly.
- Wrong key name `LOGIN_ROOM_CODE` in Dutch (`nl.json`) locale file corrected to
  `LOGIN_ROOM_NAME`.

### Security
- **WebSocket authentication:** WebSocket upgrade requests enforce HTTP Basic Auth credentials
  (when configured) before a connection is accepted, preventing unauthenticated WS connections
  when Basic Auth is in use.
- **HTTP security headers:** `helmet` middleware applies secure HTTP response header defaults.
- **Log redaction:** Plex server URLs and tokens are automatically stripped from log output
  by `pino`'s redact configuration.
- **Startup resilience:** The server starts without a Plex server configured, showing a
  browser-based setup UI rather than crashing on an empty servers list.
- **Docker secrets:** Sensitive values (`PLEX_TOKEN`, `AUTH_PASS`) can be supplied as Docker
  secret files to avoid exposure via environment variables and `docker inspect` output.
