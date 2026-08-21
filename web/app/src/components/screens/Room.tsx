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

// ─── Shared sub-components ─────────────────────────────────────────
// The desktop and mobile branches below render the same Share and Filter
// buttons, varying only by class, icon size, and label. Kept private to this
// file: they are coupled to the desktop/mobile CSS-module class names, so
// promoting them to atoms would only move the variant prop drilling.

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
    {/* Both labels share one grid cell so the button width stays stable on
        the flip: the hidden one still contributes intrinsic width.
        aria-hidden keeps them out of the accessible name, which the outer
        aria-label supplies. */}
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
  // Composed by the caller so the button needs no desktop/mobile mode flag:
  // the two branches key their active state off different classes.
  buttonClassName: string;
  badgeClassName?: string;
  ariaExpanded?: boolean;
  label?: string;
  // Mobile goes heavier to read at a smaller surface area.
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

// Clipboard fallback: navigator.clipboard is undefined on plain http://,
// reely's stated LAN deployment target. Returns whether the copy succeeded.
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
  // When reachable, sidebar match cards open local Plex instead of plex.tv.
  const localPlexReachable = useLocalPlexReachable(config?.plexBaseUrl);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [matchesOpen, setMatchesOpen] = useState(false);
  // Unfired match celebrations, newest at the END (= top of the visual
  // stack). All entries render at once, but only the topmost is active: it
  // alone can be big and its onDismiss clears the stack. z-index is uniform,
  // so DOM order decides paint order and later entries land on top. Demoted
  // entries fade via .toastReplaced and are pruned by the effect below.
  //
  // A stack, not a queue: the newest match preempts, so rapid back-to-back
  // matches do not each get a 3s window. The matches list is the canonical
  // record; the toast only carries the notification feel.
  const [pendingStack, setPendingStack] = useState<Match[]>([]);
  // Only the session's first celebration is full-screen. A ref, not a
  // matchCount check: a batch arriving in one tick would skip past a count
  // gate and show nothing as big. Flips on the first dismiss.
  const bigCelebrationShown = useRef(false);
  const dismissPending = () => {
    bigCelebrationShown.current = true;
    // Clearing the whole stack is visually a no-op: demoted entries have
    // already faded out.
    setPendingStack([]);
  };
  const [copied, setCopied] = useState(false);
  const [usersPopupOpen, setUsersPopupOpen] = useState(false);
  const isDesktop = useIsDesktop();

  // New matches are detected by media identity, not by matches.length: a
  // length check misses a re-match and fires celebrations for the stale
  // previousMatches that joinRoomSuccess loads on a rejoin. The first run
  // seeds the seen-set from whatever is present at mount so those don't pop.
  //
  // The set is undefined until the effect seeds it, hence the explicit type
  // and the `??` fallback below. It also has to be reseeded when the room
  // changes: RoomScreen does not unmount across the auto-rejoin path, so the
  // old room's ids would otherwise suppress celebrations for any media
  // sharing an id.
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
      // Arrival order, so the newest lands on top of the stack.
      const ordered = [...fresh].sort((a, b) => a.matchedAt - b.matchedAt);
      setPendingStack((prev) => [...prev, ...ordered]);
    }
    // Sync every run, not just when there were fresh entries: a rejoin can
    // change matches without producing any, leaving the seen set behind.
    for (const m of matches) seen.add(m.media.id);
  }, [room?.matches, room?.name]);

  // Prune demoted entries 400ms after the stack grows: .toastReplaced fades
  // for 200ms, and the rest is buffer so it completes before unmount. A match
  // arriving inside the window cancels and restarts the timer. Steady state is
  // one mounted match; the stack of two exists only during that window.
  useEffect(() => {
    if (pendingStack.length <= 1) return;
    const timer = setTimeout(() => {
      setPendingStack((s) => (s.length > 1 ? [s[s.length - 1]] : s));
    }, 400);
    return () => clearTimeout(timer);
  }, [pendingStack.length]);

  // Gated on filterPanelOpen: an ungated handler fires on the same Esc
  // keystroke as UsersPopup's and MatchMoment's.
  useEscape(() => setFilterPanelOpen(false), filterPanelOpen);

  // Prefetch the filter-field catalog so the filterChangeApplied toast can
  // resolve field titles before the user has opened the panel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dispatch is the store dispatch, stable across renders.
  useEffect(() => {
    if (!createRoom?.availableFilters) {
      dispatch({ type: "requestFilters" });
    }
  }, [createRoom?.availableFilters]);

  // Must precede the early return below, or hook order shifts when `room`
  // flips between defined and undefined.
  const sortedMatches = useMemo(
    () =>
      [...(room?.matches ?? [])].sort((a, b) => b.matchedAt - a.matchedAt),
    [room?.matches],
  );

  if (!room) return <ErrorMessage message="No Room!" />;

  const users = room.users ?? [];
  const filterCount = room.activeFilters?.length ?? 0;

  const isBigCelebration = !bigCelebrationShown.current;

  const handleShare = async () => {
    const url = new URL(location.href);
    url.search = "";
    url.searchParams.set("roomName", room.name);
    // URLSearchParams encodes apostrophes as %27, which is safe but ugly in a
    // shared link. They need no encoding in a query string.
    const shareUrl = url.href.replace(/%27/g, "'");

    // Fall back to execCommand, and only show "Copied!" on a real success:
    // clipboard.writeText throws on http://.
    let didCopy = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(shareUrl);
        didCopy = true;
      } catch {
        didCopy = false;
      }
    }
    if (!didCopy) didCopy = legacyCopy(shareUrl);

    if (didCopy) {
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

  // Every entry renders; only the top one is dismissable and can be big. The
  // rest take replaced=true, which fades them out. Built once here because
  // both layout branches mount identical contents in different places.
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

  // Identical across both layouts; only its container position differs.
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

          {/* Click-outside-to-dismiss for mouse users. No keydown handler: the
              keyboard path is Esc via useEscape, and adding one would make an
              invisible overlay focusable. */}
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
          /* A <button> here would override the scroll-snap and
             horizontal-overflow defaults the module.css relies on. role,
             tabIndex, and onKeyDown supply the same semantics to
             assistive tech. */
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
            aria-label={`${sortedMatches.length} matches, tap to view`}
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
          // Reserves the strip's vertical slot so the bottom bar doesn't shift
          // when the first match arrives.
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
