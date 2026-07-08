import { useCallback, useEffect, useRef, useState } from "react";
import { useEscape } from "../../hooks/useEscape";
import type { Match } from "../../../../../types/reely";
import { Avatar } from "../atoms/Avatar";
import { CloseIcon } from "../atoms/CloseIcon";
import { PlexLinks } from "../atoms/PlexLinks";
import { posterSrc } from "../../utils/poster";
import styles from "./MatchMoment.module.css";

const CONFETTI_COLORS = ["#FF4E7E", "#FF6A4D", "#FFB347", "#4ADE9E"];

// Module-scope precomputation: 20 style objects allocated once at
// load instead of once per overlay render. Values are pure functions
// of the iteration index, so they never depend on props/state. The
// big-overlay variant re-renders this list on every state change
// (Esc gating, etc.) and on every match remount, so per-render
// allocation was pure waste. (Audit 15 #388.)
const CONFETTI_PIECES = Array.from({ length: 20 }, (_, i) => ({
  left: `${(i * 37) % 100}%`,
  top: -20,
  background: CONFETTI_COLORS[i % 4],
  animationDuration: `${1.5 + (i % 5) * 0.3}s`,
  animationDelay: `${i * 0.05}s`,
  transform: `rotate(${i * 18}deg)`,
}));

// 0.5.4: ry-slide-fade-out exit animation duration in MatchMoment.module.css
// (200ms -> 350ms; renamed from ry-slide-up in 0.5.4 -- see main.css).
// Component schedules a setTimeout matching this before calling the
// parent's onDismiss so the slide+fade completes BEFORE unmount. Kept
// as a named constant + a comment because a drift between this number
// and the keyframe in MatchMoment.module.css would make the toast
// vanish mid-slide (visible jank) -- worth flagging at both ends.
const TOAST_EXIT_MS = 350;

interface MatchMomentProps {
  match: Match;
  isBig: boolean;
  onDismiss: () => void;
  // 0.5.7: true when the parent has demoted this toast (a new match
  // has arrived + is sliding in on top). Triggers .toastReplaced ->
  // 200ms opacity fade in place. Auto-dismiss is skipped (Room
  // auto-prunes this instance ~400ms after demotion). Default false
  // so non-stacked callers (most tests + the only-one-pending case)
  // see no behavior change.
  replaced?: boolean;
}

export const MatchMoment = ({ match, isBig, onDismiss, replaced = false }: MatchMomentProps) => {
  const m = match.media;

  useEscape(onDismiss, isBig);

  // Exit-animation state for the TOAST variant (audit follow-up,
  // 0.5.2). Big-overlay variant unmounts immediately on dismiss --
  // it has its own full-screen presentation, no slide-out needed.
  const [exiting, setExiting] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Trigger the exit animation, then call the parent's onDismiss after
  // the slide completes. Guard re-entry via the `exiting` flag so a
  // race between the auto-dismiss timer and a user click can't fire
  // onDismiss twice.
  const requestDismiss = useCallback(() => {
    if (exiting) return;
    setExiting(true);
    exitTimerRef.current = setTimeout(onDismiss, TOAST_EXIT_MS);
  }, [exiting, onDismiss]);

  // Unmount cleanup: if the parent yanks us mid-exit (e.g. user clicked
  // through to the next pending match), clear the pending setTimeout so
  // it doesn't fire on an unmounted component.
  useEffect(() => () => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
  }, []);

  // Demotion cancels a pending exit (audit 16 #453): if a new match
  // lands during the 350ms exit window, Room swaps this instance's
  // onDismiss to a no-op -- but the already-scheduled timer still holds
  // the OLD closure, and it always fires before Room's demotion+400ms
  // prune (dismiss started earlier), wiping the NEW toast ~150ms into
  // its window. The demoted instance's teardown belongs to Room's prune
  // timer alone.
  useEffect(() => {
    if (replaced && exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = undefined;
    }
  }, [replaced]);

  // Auto-dismiss the toast after 3s. Component remounts per match (the parent
  // sets `key={match.media.id}`), so the effect runs once per match. Deps
  // include isBig + replaced + requestDismiss: if the parent flips any of
  // those mid-toast, the effect re-runs and the timer reschedules
  // correctly instead of being silently stranded.
  // 0.5.7: also skip when `replaced` is true -- the parent is about to
  // prune this instance (Room auto-prune fires ~400ms after demotion);
  // starting an exit slide that the unmount will cut short is wasted
  // motion + visual jank.
  useEffect(() => {
    if (isBig || replaced) return;
    const timer = setTimeout(requestDismiss, 3000);
    return () => clearTimeout(timer);
  }, [isBig, replaced, requestDismiss]);

  if (!isBig) {
    return (
      <div className={styles.toastSlot}>
        <div
          className={`${styles.toast} ${exiting ? styles.toastExiting : ""} ${replaced ? styles.toastReplaced : ""}`}
        >
          <div className={styles.toastPoster}>
            {m.posterUrl ? (
              <img className={styles.toastPosterImg} src={posterSrc(m.posterUrl)} alt={m.title} />
            ) : null}
          </div>
          <div className={styles.toastBody}>
            <p className={styles.toastLabel}>New match</p>
            <p className={styles.toastTitle}>{m.title}</p>
          </div>
          <button type="button" className={styles.toastClose} onClick={requestDismiss} aria-label="Dismiss">
            <CloseIcon size={16} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    );
  }

  return (
    // role="dialog" + aria-modal + aria-label fully describe the
    // overlay to assistive tech; the click-outside-to-dismiss is a
    // mouse shortcut. Keyboard dismissal is the Esc handler in
    // useEscape above. A keydown on the overlay itself would be
    // redundant + would shift focus into the backdrop. (The dialog
    // role suppresses noStaticElementInteractions automatically;
    // useKeyWithClickEvents still fires.)
    // biome-ignore lint/a11y/useKeyWithClickEvents: dialog wrapper, Esc handles keyboard dismissal.
    <div
      className={styles.overlay}
      role="dialog"
      aria-label="Match celebration"
      aria-modal="true"
      onClick={onDismiss}
    >
      {/* The confetti list is a fixed-length 20 -- entries never reorder,
          splice, or get inserted, so the array index IS the stable identity.
          Biome's noArrayIndexKey rule guards against list-mutation bugs that
          don't apply here. Style objects are precomputed at module scope
          (CONFETTI_PIECES) so each overlay open reuses the same 20 refs
          instead of rebuilding them. */}
      {CONFETTI_PIECES.map((style, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length 20, no mutation.
          key={i}
          className={styles.confettiPiece}
          style={style}
        />
      ))}

      <h1 className={styles.headline}>
        It's a <span className={styles.headlineAccent}>match!</span>
      </h1>
      <p className={styles.subline}>
        {match.users.length === 2
          ? "You both like this one."
          : `${match.users.length} of you like this one.`}
      </p>

      <div className={styles.posterBig}>
        {m.posterUrl ? (
          <img className={styles.posterBigImg} src={posterSrc(m.posterUrl)} alt={m.title} />
        ) : (
          <div className={styles.posterBigPlaceholder}>{m.title}</div>
        )}
      </div>

      <div className={styles.avatarRow}>
        {match.users.map((name, i) => (
          <div key={name} className={i > 0 ? styles.avatarItem : undefined}>
            <Avatar userName={name} progress={0} />
          </div>
        ))}
      </div>

      {/* Wrapper exists to stop propagation -- clicks on the buttons
          inside shouldn't bubble up to the overlay's dismiss handler.
          No interactive semantics of its own; stopPropagation is the
          only handler. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper, no interactive semantics. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper, no interactive semantics. */}
      <div
        className={styles.actions}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className={styles.keepSwipingBtn} onClick={onDismiss}>
          Keep swiping
        </button>
        <PlexLinks media={m} />
      </div>
    </div>
  );
};
