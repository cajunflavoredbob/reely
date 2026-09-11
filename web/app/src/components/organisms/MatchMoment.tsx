import { useCallback, useEffect, useRef, useState } from "react";
import { useEscape } from "../../hooks/useEscape";
import type { Match } from "../../../../../types/reely";
import { Avatar } from "../atoms/Avatar";
import { CloseIcon } from "../atoms/CloseIcon";
import { PlexLinks } from "../atoms/PlexLinks";
import { posterSrc } from "../../utils/poster";
import styles from "./MatchMoment.module.css";

const CONFETTI_COLORS = ["#FF4E7E", "#FF6A4D", "#FFB347", "#4ADE9E"];

// Module scope: the values depend only on the index, and the overlay
// re-renders this list on every state change.
const CONFETTI_PIECES = Array.from({ length: 20 }, (_, i) => ({
  left: `${(i * 37) % 100}%`,
  top: -20,
  background: CONFETTI_COLORS[i % 4],
  animationDuration: `${1.5 + (i % 5) * 0.3}s`,
  animationDelay: `${i * 0.05}s`,
  transform: `rotate(${i * 18}deg)`,
}));

// Must match ry-slide-fade-out in MatchMoment.module.css: onDismiss is delayed
// by this long so the slide finishes before unmount. Drift makes the toast
// vanish mid-slide.
const TOAST_EXIT_MS = 350;

interface MatchMomentProps {
  match: Match;
  isBig: boolean;
  onDismiss: () => void;
  // Set when the parent demotes this toast because a newer match is sliding in
  // on top. Fades in place; auto-dismiss is skipped because Room prunes it.
  replaced?: boolean;
}

export const MatchMoment = ({ match, isBig, onDismiss, replaced = false }: MatchMomentProps) => {
  const m = match.media;

  useEscape(onDismiss, isBig);

  // Toast variant only; the big overlay unmounts immediately on dismiss.
  const [exiting, setExiting] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Room rebuilds onDismiss as a fresh arrow on every render, and it re-renders
  // on every userProgress broadcast. Both it and the exiting guard are held in
  // refs so requestDismiss keeps a stable identity: as a dependency of the
  // auto-dismiss effect below, a changing one tore down and re-armed the 3s
  // timer faster than anyone swipes, and the toast never self-dismissed.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const exitingRef = useRef(false);

  // Animate out, then onDismiss. The `exiting` guard stops the auto-dismiss
  // timer and a user click from both firing onDismiss.
  const requestDismiss = useCallback(() => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setExiting(true);
    exitTimerRef.current = setTimeout(() => onDismissRef.current(), TOAST_EXIT_MS);
  }, []);

  // The parent can unmount us mid-exit, so drop the pending timer.
  useEffect(() => () => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
  }, []);

  // Demotion cancels a pending exit: a timer scheduled before the demotion
  // still holds the old onDismiss closure and would fire first, wiping the NEW
  // toast. Teardown of a demoted instance belongs to Room's prune timer alone.
  useEffect(() => {
    if (replaced && exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = undefined;
    }
  }, [replaced]);

  // Auto-dismiss after 3s. The parent keys on match.media.id, so this runs once
  // per match; the deps reschedule the timer if it flips a flag mid-toast
  // rather than stranding it. Skipped when replaced: the exit slide would be
  // cut short by the parent's prune.
  useEffect(() => {
    if (isBig || replaced) return;
    const timer = setTimeout(requestDismiss, 3000);
    return () => clearTimeout(timer);
  }, [isBig, replaced, requestDismiss]);

  // The celebration declares aria-modal, which tells assistive tech everything
  // behind it is hidden, so leaving focus out there parks a keyboard user on
  // content they can no longer reach. Move focus onto the overlay's own button
  // and hand it back to whatever had it when the overlay goes. The Tab cycle
  // is still not trapped.
  const keepSwipingRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isBig) return;
    const previous = document.activeElement;
    keepSwipingRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [isBig]);

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
    // role/aria-modal/aria-label describe the overlay to assistive tech.
    // Click-outside is a mouse shortcut; keyboard dismissal is the useEscape
    // handler above. A keydown here would shift focus into the backdrop.
    // biome-ignore lint/a11y/useKeyWithClickEvents: dialog wrapper, Esc handles keyboard dismissal.
    <div
      className={styles.overlay}
      role="dialog"
      aria-label="Match celebration"
      aria-modal="true"
      onClick={onDismiss}
    >
      {/* Clipping layer of its own: the pieces fall 700px, which would
          otherwise count as scrollable overflow now that the overlay scrolls.
          Fixed-length list that never reorders, so the index is stable
          identity. */}
      <div className={styles.confettiLayer}>
        {CONFETTI_PIECES.map((style, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length 20, no mutation.
            key={i}
            className={styles.confettiPiece}
            style={style}
          />
        ))}
      </div>

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

      {/* stopPropagation so button clicks don't reach the overlay's dismiss
          handler. No interactive semantics of its own. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper, no interactive semantics. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper, no interactive semantics. */}
      <div
        className={styles.actions}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={styles.keepSwipingBtn}
          onClick={onDismiss}
          ref={keepSwipingRef}
        >
          Keep swiping
        </button>
        <PlexLinks media={m} />
      </div>
    </div>
  );
};
