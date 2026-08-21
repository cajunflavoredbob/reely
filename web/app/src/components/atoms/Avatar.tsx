import { type CSSProperties, memo, useId } from "react";

import styles from "./Avatar.module.css";
import { userHue } from "../../utils/userHue";

interface AvatarProps {
  userName: string;
  // Unreachable under Plex (no per-user avatars); wired for Emby/Jellyfin.
  avatarUrl?: string;
  progress?: number;
}

// Intersected with CSSProperties so a typo like `--huee` fails typecheck.
type AvatarCssVars = { "--hue": number; "--progress": number };

// memo: skips the hash + SVG build; all props primitive, so shallow eq holds.
export const Avatar = memo(({ userName, avatarUrl, progress = 0 }: AvatarProps) => {
  // Shared util so Avatar and UserPill agree on a name's hue.
  const nameHue = userHue(userName);
  const letter = userName.toUpperCase()[0];

  // SVG ids must be unique per instance and stable across renders.
  const uid = useId();
  const avatarImageId = `avatar-image-${uid}`;
  const avatarMask = `avatar-mask-${uid}`;

  return (
    <svg
      width="32"
      height="32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      xmlnsXlink="http://www.w3.org/1999/xlink"
      // aria-hidden: decorative; the surrounding label carries the name.
      aria-hidden="true"
      style={{ "--hue": nameHue, "--progress": progress } as CSSProperties & AvatarCssVars}
      className={styles.avatar}
    >
      <circle cx="16" cy="16" r="13" className={styles.avatarCircle} />
      <mask
        id={avatarMask}
        maskUnits="userSpaceOnUse"
        x="2"
        y="2"
        width="28"
        height="28"
      >
        <circle cx="16" cy="16" r="13" fill="#fff" />
      </mask>
      {avatarUrl && (
        <g mask={`url(#${avatarMask})`}>
          <image
            id={avatarImageId}
            width="100%"
            height="100%"
            xlinkHref={avatarUrl}
          />
        </g>
      )}
      <g>
        {progress > 0 && <circle cx="16" cy="16" r="15" className={styles.progress} />}
        {!avatarUrl &&
          <text
            x="50%"
            y="55%"
            textAnchor="middle"
            dy=".3em"
            className={styles.letter}
          >
            {letter}
          </text>}
      </g>
    </svg>
  );
});
