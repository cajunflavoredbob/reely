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

// Typo-safe CSS-var keys, as in Avatar.
type UserPillCssVars = { "--hue": number; "--progress": string };

// Purely layout: the full name stays recoverable from title= on hover. The
// users popup renders this same pill, so it is truncated there too.
//
// Counted and cut by code point, not code unit: slicing an emoji in half
// leaves a lone surrogate, which renders as the replacement glyph.
const TRUNCATE_AT = 14;
const display = (name: string) => {
  const chars = [...name];
  return chars.length > TRUNCATE_AT
    ? `${chars.slice(0, TRUNCATE_AT - 1).join("")}…`
    : name;
};

// memo: one per user in UserPillRow and UsersPopup, so progress-bump churn
// adds up. All props primitive, so shallow equality is correct.
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
