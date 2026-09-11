import { useEffect, useMemo, useRef } from "react";
import type { UserProgress } from "../../../../../types/reely";
import { CloseIcon } from "../atoms/CloseIcon";
import { UserPill } from "../atoms/UserPill";
import { useEscape } from "../../hooks/useEscape";
import styles from "./UsersPopup.module.css";

// From index.html's <body data-version="${version}">, substituted by
// cmd/reely/main.ts in prod and injectDevVars in dev. Undefined under jsdom,
// where nothing substitutes it. Module scope: the dataset never changes.
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
  // Escape closes, matching every sibling overlay.
  useEscape(onClose);

  // The dialog declares aria-modal, which tells assistive tech everything
  // behind it is hidden, so leaving focus on the trigger parks a keyboard user
  // on content they can no longer reach. Move focus onto the close button and
  // hand it back when the dialog goes. The Tab cycle is still not trapped.
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeBtnRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  // "Me" first, then descending progress, so the most-engaged users sit at
  // the top.
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
    // Backdrop click-to-close; keyboard dismissal is the useEscape handler.
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
          {/* Version label sits with the close button: passive metadata, and
              the header already terminates at that edge. */}
          <div className={styles.headerActions}>
            {APP_VERSION && (
              <span className={styles.version}>v{APP_VERSION}</span>
            )}
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="Close"
              ref={closeBtnRef}
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
