import { useMemo } from "react";
import type { UserProgress } from "../../../../../types/reely";
import { UserPill } from "../atoms/UserPill";
import styles from "./UserPillRow.module.css";

interface UserPillRowProps {
  users: UserProgress[];
  myUserName?: string;
  onClick: () => void;
  // Pills shown inline before overflow collapses into a +N badge. Mobile
  // passes a smaller value to keep the top bar uncrowded next to the logo.
  maxVisible?: number;
}

export const UserPillRow = ({
  users,
  myUserName,
  onClick,
  maxVisible = 4,
}: UserPillRowProps) => {
  // Pin the current user's pill to the front so they're always inline, even
  // in a crowded room. Other users keep server order. Memoized (audit
  // 14 #333) so the clone-and-sort only re-runs when the input list or
  // myUserName actually changes -- not on every parent re-render.
  const ordered = useMemo(
    () =>
      [...users].sort((a, b) => {
        if (a.user.userName === myUserName) return -1;
        if (b.user.userName === myUserName) return 1;
        return 0;
      }),
    [users, myUserName],
  );
  const visible = ordered.slice(0, maxVisible);
  const overflow = ordered.length - visible.length;

  return (
    <button
      type="button"
      className={styles.row}
      onClick={onClick}
      aria-label={`Show all ${users.length} users in room`}
    >
      {visible.map((up) => (
        <UserPill
          key={up.user.userName}
          userName={up.user.userName}
          progress={up.progress * 100}
          isMe={up.user.userName === myUserName}
        />
      ))}
      {overflow > 0 && <span className={styles.overflow}>+{overflow}</span>}
    </button>
  );
};
