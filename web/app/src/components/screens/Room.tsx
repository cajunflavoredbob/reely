import { useEffect, useMemo, useRef, useState } from "react";
import type { Filter, Match } from "../../../../../types/reely";
import { ErrorMessage } from "../atoms/ErrorMessage";
import { Logo } from "../atoms/Logo";
import { Layout } from "../layout/Layout";
import { Card } from "../molecules/Card";
import { UserPillRow } from "../molecules/UserPillRow";
import { CardStack } from "../organisms/CardStack";
import { FilterPanel } from "../organisms/FilterPanel";
import { MatchesList } from "../organisms/MatchesList";
import { MatchMoment } from "../organisms/MatchMoment";
import { UsersPopup } from "../organisms/UsersPopup";

import styles from "./Room.module.css";
import { useStore } from "../../store";
import { useEscape } from "../../hooks/useEscape";
import { buildPlexLinks, useLocalPlexReachable } from "../../utils/plexLinks";
import { posterSrc } from "../../utils/poster";

// ─── Shared sub-components (audit 13 #281) ─────────────────────────
// The desktop and mobile branches of <RoomScreen> below both render a
// Share button + a Filter button with identical structure -- only the
// CSS class, icon size, and label vary. Extracting them as private
// components inside this file (no public API surface) collapses ~50
// lines of duplicated JSX between the two branches.
//
// Kept INSIDE Room.tsx rather than as separate atom files because
// they're tightly coupled to the desktop/mobile CSS-module class
// names; promoting them to atoms/molecules would just shift the
// "which variant?" prop drilling somewhere else.

interface ShareButtonProps {
  onClick: () => void;
  copied: boolean;
  size: number;
  className: string;
}

const ShareButton = ({ onClick, copied, size, className }: ShareButtonProps) => (
  <button type="button" className={className} onClick={onClick} aria-label="Copy room link">
    {copied ? (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2.5 8l4 4 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ) : (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6.5 9.5a3.5 3.5 0 005 0l2-2a3.5 3.5 0 00-5-5L7 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M9.5 6.5a3.5 3.5 0 00-5 0l-2 2a3.5 3.5 0 005 5L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )}
    {/* Stack both labels in one grid cell so the button width is
        max("Share", "Copied!") and stays stable on the flip --
        the inactive label is visibility:hidden so it doesn't
        draw, but still contributes to the cell's intrinsic width.
        The outer aria-label="Copy room link" remains the screen-
        reader read; aria-hidden on these spans keeps the active
        label out of the accessible-name calculation. */}
    <span className={styles.shareBtnLabel}>
      <span aria-hidden={copied}>Share</span>
      <span aria-hidden={!copied}>Copied!</span>
    </span>
  </button>
);

interface FilterButtonProps {
  onClick: () => void;
  filterCount: number;
  size: number;
  // Composed by the caller -- desktop folds in a desktopFilterBtnActive
  // class tied to the panel-open state; mobile uses a different
  // active-vs-inactive class entirely. Caller composes the final
  // string so the button doesn't need a desktop/mobile mode flag.
  buttonClassName: string;
  badgeClassName?: string;
  ariaExpanded?: boolean;
  label?: string;
  // Different stroke widths between contexts (desktop is finer at 1.5,
  // mobile beefier at 2 to read at smaller surface area).
  strokeWidth?: number;
}

const FilterButton = ({
  onClick, filterCount, size, buttonClassName, badgeClassName,
  ariaExpanded, label = "Filter", strokeWidth = 2,
}: FilterButtonProps) => (
  <button
    type="button"
    className={buttonClassName}
    onClick={onClick}
    aria-expanded={ariaExpanded}
    aria-label="Filters"
  >
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4h12M4 8h8M6 12h4" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
    {label}
    {filterCount > 0 && badgeClassName && (
      <span className={badgeClassName}>{filterCount}</span>
    )}
  </button>
);

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => window.matchMedia("(min-width: 900px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isDesktop;
}

// Clipboard fallback for non-secure contexts. navigator.clipboard is
// undefined on plain http:// -- reely's stated LAN deployment target -- so a
// temp-textarea + execCommand path is needed there. Returns whether the copy
// actually succeeded.
const legacyCopy = (text: string): boolean => {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};

export const RoomScreen = () => {
  const [{ room, user, createRoom, config }, dispatch] = useStore(["room", "user", "createRoom", "config"]);
  // Probe once whether the browser can reach the local Plex server; if so,
  // the desktop sidebar match cards open Plex locally instead of via plex.tv.
  const localPlexReachable = useLocalPlexReachable(config?.plexBaseUrl);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [matchesOpen, setMatchesOpen] = useState(false);
  // Stack of unfired match celebrations -- newest at the END of the array
  // (= top of the visual stack). All entries render simultaneously; only
  // the topmost is functionally active (its onDismiss clears the whole
  // stack, only it can be big). Older entries fade out via the
  // .toastReplaced class on MatchMoment and are auto-pruned ~400ms later
  // by the effect below. z-index is uniform across slots (150); paint
  // order = DOM order, so later-appended entries naturally end up on top.
  //
  // 0.5.7 changed this from a FIFO queue (audit 11 #178: oldest first,
  // advance on dismiss, every match got its own celebration moment) to
  // a stack per the owner's feedback after 0.5.6 landed the slide-in
  // animation: "the new match notification needs to slide down on top
  // of the existing one. The new notification replaces the previous
  // one." Trade-off (explicit reversal of audit 11 #178): rapid back-
  // to-back matches no longer each get their own 3s celebration window
  // -- the latest preempts. The matches list (sidebar / popup) is still
  // the canonical record of every match; the toast is for the active-
  // notification feel only.
  const [pendingStack, setPendingStack] = useState<Match[]>([]);
  // The very first celebration of the session gets the full-screen overlay;
  // all subsequent ones get the small toast. Tracked via a ref so a batch
  // of fresh matches arriving in the same tick doesn't blow past the
  // heuristic -- the prior `matchCount === 1` gate would have jumped to 3
  // on a 3-match batch and shown nothing as big. The ref flips on the
  // first dismiss, regardless of how many matches the user is queued
  // through.
  const bigCelebrationShown = useRef(false);
  const dismissPending = () => {
    bigCelebrationShown.current = true;
    // Clear the whole stack -- demoted entries were already faded out by
    // .toastReplaced and are invisible; unmounting them all at once with
    // the dismissed top is visually a no-op.
    setPendingStack([]);
  };
  const [copied, setCopied] = useState(false);
  const [usersPopupOpen, setUsersPopupOpen] = useState(false);
  const isDesktop = useIsDesktop();

  // Celebrate genuinely new matches by media identity, not by matches.length.
  // Length comparison missed a re-match (same title, length unchanged) and --
  // worse -- fired celebrations for stale matches when joinRoomSuccess loaded
  // previousMatches wholesale on a rejoin. The first effect run seeds the
  // seen-set from the matches present at mount (the join's previousMatches)
  // so those don't pop.
  //
  // `useRef<Set<string>>()` (audit 9 #136 / clarified for audit 11 #187):
  // React keeps the FIRST ref value across renders -- subsequent renders
  // never see a new initializer. Passing `new Set(...)` inline would
  // re-allocate the Set on every render and discard each copy. The
  // pattern here -- typed as `useRef<Set<string>>()` with undefined
  // initial value, populated inside the effect -- allocates the Set
  // exactly once at first effect run.
  //
  // On a room CHANGE (audit 12 #244) the seen-set is reseeded from the
  // new room's previousMatches. RoomScreen doesn't unmount across the
  // auto-rejoin path (0.3.19 #17 keeps the route as "room"), so without
  // this reset the previous room's match ids would persist and suppress
  // celebrations in the new room for any media that happened to share
  // an id (rare, but real for franchises across libraries).
  // Type narrowed in 0.4.19 (audit 13 #307). The prior
  // `useRef<Set<string>>()` LOOKED like a ref of a Set but under
  // strict TS it resolves to `MutableRefObject<Set<string> | undefined>`
  // -- the current value is undefined until the effect below seeds it.
  // Explicit `Set<string> | undefined` matches the actual semantics so
  // a reader doesn't think `seenMatchIds.current` is always present.
  // The `?? new Set<string>()` fallback at line 117 already handles
  // the pre-seed window correctly; just spelling it out in the type.
  const seenMatchIds = useRef<Set<string> | undefined>(undefined);
  const lastSeenRoomName = useRef<string | undefined>(undefined);
  useEffect(() => {
    const matches = room?.matches;
    const name = room?.name;
    if (!matches || !name) return;
    // Room changed (or first init): reseed from previousMatches.
    if (lastSeenRoomName.current !== name) {
      lastSeenRoomName.current = name;
      seenMatchIds.current = new Set(matches.map((m) => m.media.id));
      return;
    }
    const seen = seenMatchIds.current ?? new Set<string>();
    seenMatchIds.current = seen;
    const fresh = matches.filter((m) => !seen.has(m.media.id));
    if (fresh.length > 0) {
      // Append fresh matches in arrival order. The last one ends up at
      // the top of the stack -- newest wins. When several arrive in the
      // same tick they all mount together; the top is what the user
      // sees + only the top runs the dismiss path (others are no-op).
      // (0.5.7: was a FIFO queue per audit 11 #178; see the pendingStack
      // declaration above for the rationale on the model change.)
      const ordered = [...fresh].sort((a, b) => a.matchedAt - b.matchedAt);
      setPendingStack((prev) => [...prev, ...ordered]);
    }
    // Always sync the seen set with the current matches (audit 14 #366).
    // Previously the seen.add loop was inside the `fresh.length > 0`
    // branch, so on a path where matches changed but produced no fresh
    // entries (rejoin paths, server replays the same set), the seen set
    // could fall behind. Defensive: keep seen aligned with matches every
    // run regardless.
    for (const m of matches) seen.add(m.media.id);
  }, [room?.matches, room?.name]);

  // 0.5.7: Auto-prune demoted entries from pendingStack 400ms after the
  // stack grew beyond a single entry. .toastReplaced's fade is 200ms;
  // the extra 200ms is buffer so the fade completes cleanly before the
  // unmount. If another match arrives during this window, the effect
  // re-runs (pendingStack.length changed) and the previous timer is
  // canceled, restarting the prune clock with the newer outgoing as
  // the demoted one. Net effect: at any steady state, only the topmost
  // match is mounted; the transient stack of two only exists during
  // the 400ms window between arrival and prune.
  useEffect(() => {
    if (pendingStack.length <= 1) return;
    const timer = setTimeout(() => {
      setPendingStack((s) => (s.length > 1 ? [s[s.length - 1]] : s));
    }, 400);
    return () => clearTimeout(timer);
  }, [pendingStack.length]);

  // Escape closes the filter panel only when it's actually open. Without
  // this gate the handler runs unconditionally and conflicts with other
  // overlays' Escape handlers (UsersPopup, MatchMoment) -- they all
  // fire on a single Esc keystroke (audit 12 #243). Gating on
  // filterPanelOpen scopes Room's listener to the case where it has
  // something to do.
  useEscape(() => setFilterPanelOpen(false), filterPanelOpen);

  // Prefetch the filter-field catalog so the toast on filterChangeApplied
  // can resolve field titles even when the user hasn't opened the panel yet.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dispatch is stable across renders (it's the reducer-store dispatch); adding it as a dep would just satisfy the rule without behavior change.
  useEffect(() => {
    if (!createRoom?.availableFilters) {
      dispatch({ type: "requestFilters" });
    }
  }, [createRoom?.availableFilters]);

  // sortedMatches must be computed before the early return so hook order is
  // stable across room=defined/undefined transitions (Rules of Hooks).
  const sortedMatches = useMemo(
    () =>
      [...(room?.matches ?? [])].sort((a, b) => b.matchedAt - a.matchedAt),
    [room?.matches],
  );

  if (!room) return <ErrorMessage message="No Room!" />;

  const users = room.users ?? [];
  const filterCount = room.activeFilters?.length ?? 0;

  // Only the first match of the session gets the full-overlay celebration;
  // subsequent matches show the small toast.
  const isBigCelebration = !bigCelebrationShown.current;

  const handleShare = async () => {
    const url = new URL(location.href);
    url.search = "";
    url.searchParams.set("roomName", room.name);
    // URLSearchParams encodes apostrophes as %27. They're safe unencoded in
    // a query string, so leave them readable in the share link
    // ("?roomName=bob's+room" instead of "?roomName=bob%27s+room").
    const shareUrl = url.href.replace(/%27/g, "'");

    // navigator.clipboard is undefined on plain http:// (non-secure context).
    // Try it when available, fall back to execCommand, and only show "Copied!"
    // on a real success -- the old code always showed it even when the copy
    // threw on http://.
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) copied = legacyCopy(shareUrl);

    if (copied) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      // Last resort: surface the link so the user can copy it by hand.
      window.prompt("Copy this room link:", shareUrl);
    }
  };

  const handleApply = (filters: Filter[]) => {
    dispatch({ type: "applyFilters", payload: { filters } });
  };

  const cardStack = (
    <CardStack
      key={room.mediaVersion ?? 0}
      cards={room.media ?? []}
      onCardDismissed={(card, rating) =>
        dispatch({
          type: "rate",
          payload: { mediaId: card.id, rating: rating === "left" ? "dislike" : "like" },
        })
      }
      renderCard={(card) => <Card media={card} key={card.id} />}
    />
  );

  // Render the pendingStack of MatchMoment toasts. Mounted in both the
  // desktop swipe stage and the mobile top-level layout (the JSX moves
  // per layout; the contents are identical). Audit 15 #386 hoisted this
  // above the desktop/mobile branching so it appears once. 0.5.7: render
  // all entries -- newest at the end of the array = top of the visual
  // stack. Only the top is functionally active (dismissable, can be big);
  // the rest get replaced=true which fades them out via .toastReplaced
  // (see MatchMoment.module.css).
  const matchMomentStack = pendingStack.map((m, i) => {
    const isTop = i === pendingStack.length - 1;
    return (
      <MatchMoment
        key={m.media.id}
        match={m}
        isBig={isTop && isBigCelebration}
        onDismiss={isTop ? () => dismissPending() : () => {}}
        replaced={!isTop}
      />
    );
  });

  // UsersPopup is identical across desktop + mobile (just different
  // container positions in each branch). Audit 15 #386 hoisted.
  const usersPopup = usersPopupOpen && (
    <UsersPopup
      users={users}
      myUserName={user?.userName}
      onClose={() => setUsersPopupOpen(false)}
      onLeave={() => dispatch({ type: "leaveRoom" })}
    />
  );

  // ─── Desktop layout ───────────────────────────────────────────────────
  if (isDesktop) {
    return (
      <div className={styles.desktopLayout}>
        {/* Top bar */}
        <header className={styles.desktopTopBar}>
          <Logo />

          <div className={styles.desktopRoomMeta}>
            <div className={styles.desktopRoomName}>
              <div className={styles.desktopRoomLabel}>Room</div>
              <div className={styles.desktopRoomValue}>{room.displayName ?? room.name}</div>
            </div>
            <div className={styles.desktopDivider} />
            <div className={styles.desktopAvatarGroup}>
              <UserPillRow
                users={users}
                myUserName={user?.userName}
                onClick={() => setUsersPopupOpen(true)}
                maxVisible={5}
              />
              <span className={styles.desktopSwipingCount}>
                {users.length} swiping
              </span>
            </div>
          </div>

          <div className={styles.desktopTopBarActions}>
            <ShareButton
              onClick={handleShare}
              copied={copied}
              size={13}
              className={styles.desktopShareBtn}
            />
            <FilterButton
              onClick={() => setFilterPanelOpen((v) => !v)}
              filterCount={filterCount}
              size={13}
              strokeWidth={1.5}
              label="Filters"
              ariaExpanded={filterPanelOpen}
              buttonClassName={`${styles.desktopFilterBtn} ${filterPanelOpen ? styles.desktopFilterBtnActive : ""}`}
              badgeClassName={`${styles.desktopFilterBadge} ${filterPanelOpen ? styles.desktopFilterBadgeActive : ""}`}
            />
          </div>
        </header>

        {/* Main row */}
        <div className={styles.desktopMain}>
          {/* Left: matches sidebar */}
          <aside className={styles.desktopSidebar}>
            <div className={styles.desktopSidebarHeader}>
              <h2 className={styles.desktopSidebarTitle}>Matches</h2>
              <span className={styles.desktopSidebarCount}>{sortedMatches.length}</span>
            </div>
            <div className={styles.desktopMatchList}>
              {sortedMatches.length === 0 ? (
                <div className={styles.desktopMatchEmpty}>
                  Movies two or more<br />of you love will land here.
                </div>
              ) : (
                sortedMatches.map((match) => {
                  const webUrl = buildPlexLinks(
                    match.media,
                    config?.plexServerId,
                    config?.plexBaseUrl,
                    localPlexReachable === true,
                  )?.webUrl;
                  return (
                  <button
                    type="button"
                    key={match.media.id}
                    className={styles.desktopMatchCard}
                    onClick={() =>
                      webUrl && window.open(webUrl, "_blank", "noopener")
                    }
                  >
                    <div className={styles.desktopMatchPoster}>
                      {match.media.posterUrl && (
                        <img
                          className={styles.desktopMatchPosterImg}
                          src={posterSrc(match.media.posterUrl)}
                          alt={match.media.title}
                          loading="lazy"
                        />
                      )}
                    </div>
                    <div className={styles.desktopMatchInfo}>
                      <div className={styles.desktopMatchTitle}>{match.media.title}</div>
                      <div className={styles.desktopMatchMeta}>
                        {match.media.year}
                        {match.media.rating ? ` · ★ ${match.media.rating}` : ""}
                      </div>
                    </div>
                  </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* Center: swipe stage */}
          <div className={styles.desktopSwipeStage}>
            {matchMomentStack}
            {cardStack}
          </div>

          {/* Filter backdrop -- click-outside-to-dismiss shortcut for
              mouse users. Keyboard users dismiss via Esc (useEscape
              above; same handler) so a backdrop keydown handler would
              be redundant + would make the backdrop focusable, which
              is wrong for an invisible overlay. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard path is Esc via useEscape. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard path is Esc via useEscape. */}
          <div
            className={`${styles.desktopFilterBackdrop} ${filterPanelOpen ? styles.desktopFilterBackdropOpen : ""}`}
            onClick={() => setFilterPanelOpen(false)}
          />

          {/* Filter drawer */}
          <div
            className={`${styles.desktopFilterDrawer} ${filterPanelOpen ? styles.desktopFilterDrawerOpen : ""}`}
          >
            <FilterPanel
              onClose={() => setFilterPanelOpen(false)}
              onApply={handleApply}
              isDrawer
              isOpen={filterPanelOpen}
            />
          </div>
        </div>

        {usersPopup}
      </div>
    );
  }

  // ─── Mobile layout ────────────────────────────────────────────────────
  return (
    <Layout hideLogo className={styles.screen}>

      {/* Top bar: logo + avatar stack */}
      <div className={styles.mobileTopBar}>
        <Logo size={24} />
        <div className={styles.mobileAvatarGroup}>
          <UserPillRow
            users={users}
            myUserName={user?.userName}
            onClick={() => setUsersPopupOpen(true)}
            maxVisible={3}
          />
          <span className={styles.mobileSwipingCount}>{users.length} swiping</span>
        </div>
      </div>

      {matchMomentStack}

      {cardStack}

      {/* Bottom bar: share/filter + match strip */}
      <div className={styles.mobileBottomBar}>
        <div className={styles.mobileActions}>
          <ShareButton
            onClick={handleShare}
            copied={copied}
            size={15}
            className={styles.mobileShareBtn}
          />
          <FilterButton
            onClick={() => setFilterPanelOpen(true)}
            filterCount={filterCount}
            size={15}
            buttonClassName={filterCount > 0 ? styles.mobileFilterBtnActive : styles.mobileFilterBtn}
            badgeClassName={styles.mobileFilterBadge}
          />
        </div>

        {sortedMatches.length > 0 ? (
          /* The mobile match strip is a horizontally-scrollable bar of
             poster thumbs that scrolls + opens MatchesList on click.
             Converting to <button> would override the browser's
             scroll-snap + horizontal-overflow defaults that the
             module.css relies on. role="button" + tabIndex + the
             explicit onKeyDown handler give it the same semantics
             as a real button for assistive tech. Worth revisiting if
             the layout ever simplifies enough that a button reset
             is cheap. */
          // biome-ignore lint/a11y/useSemanticElements: scroll-snap defaults require div; semantics covered by role + tabIndex + onKeyDown.
          <div
            className={styles.mobileMatchStrip}
            onClick={() => setMatchesOpen(true)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setMatchesOpen(true);
              }
            }}
            aria-label={`${sortedMatches.length} matches – tap to view`}
          >
            {sortedMatches.map((match) => (
              <div key={match.media.id} className={styles.mobileMatchThumb}>
                {match.media.posterUrl ? (
                  <img
                    className={styles.mobileMatchPoster}
                    src={posterSrc(match.media.posterUrl)}
                    alt={match.media.title}
                    loading="lazy"
                  />
                ) : (
                  <div className={styles.mobileMatchPosterFallback}>
                    {match.media.title}
                  </div>
                )}
                <p className={styles.mobileMatchTitle}>{match.media.title}</p>
              </div>
            ))}
          </div>
        ) : (
          // Placeholder reserves the same vertical slot as the strip, so the
          // bottom bar doesn't shift when the first match arrives.
          <div className={styles.mobileMatchEmpty}>
            matches will appear here as you swipe
          </div>
        )}
      </div>

      {filterPanelOpen && (
        <FilterPanel
          onClose={() => setFilterPanelOpen(false)}
          onApply={handleApply}
          isOpen={filterPanelOpen}
        />
      )}

      {matchesOpen && <MatchesList onClose={() => setMatchesOpen(false)} />}

      {usersPopup}
    </Layout>
  );
};
