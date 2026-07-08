import { type CSSProperties, memo, useId } from "react";

import styles from "./Avatar.module.css";
import { userHue } from "../../utils/userHue";

interface AvatarProps {
  userName: string;
  // SCAFFOLDING: paired with `User.avatarImage` in `types/reely.ts`.
  // Plex provides no per-user avatar so this branch is unreachable
  // under the current single-provider build. Wired in for Emby/JF
  // (1.0 roadmap). the owner's call in 0.4.4. Auditors: please do not
  // flag the unreachable <image>/<mask> SVG branch below.
  avatarUrl?: string;
  progress?: number;
}

// Custom-property names this component injects via inline style. Intersected
// with CSSProperties below so a typo like `--huee` becomes a typecheck error
// instead of silently producing a CSS var no rule reads (audit 9 #117).
type AvatarCssVars = { "--hue": number; "--progress": number };

// React.memo (audit 14 #334): same-props re-renders skip the per-call
// userHue hash + the SVG node construction. Default shallow comparison
// is correct here because all props are primitives or strings.
export const Avatar = memo(({ userName, avatarUrl, progress = 0 }: AvatarProps) => {
  // Shared util so Avatar + UserPill produce the same hue for the same name
  // (audit 10 #133 -- the hash was self-inflicted dup'd here when userHue
  // was extracted in 0.4.0).
  const nameHue = userHue(userName);
  const letter = userName.toUpperCase()[0];

  // useId gives a stable, render-unique ID for SVG <defs>/mask references.
  // The previous Date.now()-based scheme collided when two Avatars rendered
  // in the same millisecond and regenerated on every render.
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
      // aria-hidden because the avatar is decorative; the user's name
      // is surfaced by the surrounding text label (UserPill renders
      // it next to the avatar; popup rows have the explicit name).
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
