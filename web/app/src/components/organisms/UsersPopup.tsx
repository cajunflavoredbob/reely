import { useMemo } from "react";
import type { UserProgress } from "../../../../../types/reely";
import { CloseIcon } from "../atoms/CloseIcon";
import { UserPill } from "../atoms/UserPill";
import { useEscape } from "../../hooks/useEscape";
import styles from "./UsersPopup.module.css";

// Build-time version from index.html's <body data-version="${version}">.
// Server substitutes ${version} at request time (cmd/reely/main.ts);
// vite dev substitutes via injectDevVars in vite.config.ts. Undefined
// in jsdom tests (no template substitution) -- the span renders only
// when a real value is present so test DOM stays clean.
// Hoisted to module scope: document.body.dataset doesn't change at
// runtime, no need to re-read per render.
// (0.5.4) Added so users can confirm what version they're running
// without dev tools -- lives in the room-roster popup because that's
// the existing "info about this session" surface.
const APP_VERSION =
  typeof document !== "undefined" ? document.body.dataset.version : undefined;

interface UsersPopupProps {
  users: UserProgress[];
  myUserName?: string;
  onClose: () => void;
  onLeave: () => void;
}

export const UsersPopup = ({
  users,
  myUserName,
  onClose,
  onLeave,
}: UsersPopupProps) => {
  // Close on Escape -- matches FilterPanel + MatchMoment behavior so users
  // don't have to remember which overlays support it.
  useEscape(onClose);

  // "Me" first, then descending progress -- most-engaged users sit near
  // the top of the list. Memoized (audit 14 #333) so the clone-and-sort
  // doesn't re-run on every parent render.
  const ordered = useMemo(
    () =>
      [...users].sort((a, b) => {
        if (a.user.userName === myUserName) return -1;
        if (b.user.userName === myUserName) return 1;
        return b.progress - a.progress;
      }),
    [users, myUserName],
  );

  return (
    // Backdrop click-to-close + dialog stopPropagation: keyboard
    // dismissal is the Esc handler in useEscape above.
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop, Esc handles keyboard dismissal.
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop, Esc handles keyboard dismissal.
    <div className={styles.backdrop} onClick={onClose}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: dialog stopPropagation wrapper, no own keyboard semantics. */}
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="users-popup-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 id="users-popup-title" className={styles.title}>
            In this room <span className={styles.count}>({users.length})</span>
          </h2>
          {/* Right-side cluster: version label + close button. 0.5.4
              added the version label so users can confirm what they're
              running without dev tools. Lives next to the close button
              because (a) it's passive metadata, not a primary action,
              and (b) the right-edge is where the header already
              terminates -- no new visual anchor needed. */}
          <div className={styles.headerActions}>
            {APP_VERSION && (
              <span className={styles.version}>v{APP_VERSION}</span>
            )}
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="Close"
            >
              <CloseIcon size={16} strokeWidth={2.5} />
            </button>
          </div>
        </header>

        <ul className={styles.list}>
          {ordered.map((up) => (
            <li key={up.user.userName} className={styles.listItem}>
              <UserPill
                userName={up.user.userName}
                progress={up.progress * 100}
                isMe={up.user.userName === myUserName}
              />
              <span className={styles.progressText}>
                {Math.round(up.progress * 100)}%
              </span>
            </li>
          ))}
        </ul>

        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.leaveBtn}
            onClick={() => {
              onLeave();
              onClose();
            }}
          >
            Leave room
          </button>
        </footer>
      </div>
    </div>
  );
};
