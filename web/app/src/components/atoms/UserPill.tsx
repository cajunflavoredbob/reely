import { memo, type CSSProperties } from "react";
import styles from "./UserPill.module.css";
import { userHue } from "../../utils/userHue";

interface UserPillProps {
  userName: string;
  // 0-100; rendered as a left-to-right background fill behind the label.
  progress?: number;
  // Subtle outer ring marks the current user's own pill.
  isMe?: boolean;
}

// Same as Avatar: typo-safe CSS-var keys (audit 9 #117).
type UserPillCssVars = { "--hue": number; "--progress": string };

// Truncate names that would overflow the pill width. The full name still
// appears in the users popup, so this is purely a layout concern. 14 chars
// covers typical usernames; longer ones get an ellipsis + full value in
// title= for hover tooltips.
const TRUNCATE_AT = 14;
const display = (name: string) =>
  name.length > TRUNCATE_AT ? `${name.slice(0, TRUNCATE_AT - 1)}…` : name;

// React.memo (audit 14 #334): UserPill is rendered N times per UserPillRow
// and N times per UsersPopup; with N typically 3-10 the savings are modest
// per render but real across reconnect / progress-bump churn. All props
// are primitives so shallow equality is correct.
export const UserPill = memo(({
  userName,
  progress = 0,
  isMe = false,
}: UserPillProps) => {
  const hue = userHue(userName);
  const pct = Math.max(0, Math.min(100, progress));
  return (
    <span
      className={`${styles.pill} ${isMe ? styles.pillMe : ""}`}
      style={{ "--hue": hue, "--progress": `${pct}%` } as CSSProperties & UserPillCssVars}
      title={userName}
    >
      <span className={styles.fill} aria-hidden="true" />
      <span className={styles.label}>{display(userName)}</span>
    </span>
  );
});
