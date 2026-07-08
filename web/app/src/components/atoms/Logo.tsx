import { memo, useId } from "react";
import styles from "./Logo.module.css";

interface LogoProps {
  size?: number;
  withWord?: boolean;
}

// React.memo (audit 14 #334): Logo is rendered as a static brand mark
// in several layouts; props (size + withWord) are stable across most
// re-renders of those parents. Memo skips the SVG node construction
// when props are unchanged.
export const Logo = memo(({ size = 28, withWord = true }: LogoProps) => {
  // useId per render so two Logos on the same page don't collide on a
  // shared `<linearGradient>` id. SVG ids are global; without this, a
  // second Logo's gradient fill resolved to the first Logo's gradient
  // (or broke when the first unmounted). React's useId already returns
  // a unique value -- audit 12 #195 dropped the prior template-literal
  // wrapping (`ry-mark-grad-${useId()}`) since the extra prefix was
  // pure noise + a per-render string allocation.
  const gradId = useId();
  return (
    <div className={styles.root}>
      {/* aria-hidden: the Logo's role-as-brand-mark; the textual
          "reely" wordmark below (when withWord) carries the label
          for screen readers. */}
      <svg width={size} height={size} viewBox="0 0 112 112" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="112" y2="112" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FF4E7E" />
            <stop offset="50%" stopColor="#FF6A4D" />
            <stop offset="100%" stopColor="#FFB347" />
          </linearGradient>
        </defs>
        <rect x="16" y="0" width="80" height="106" rx="10" fill="#3a2118" />
        <rect x="13" y="8" width="86" height="98" rx="11" fill="#62342a" />
        <rect x="10" y="16" width="92" height="90" rx="12" fill={`url(#${gradId})`} />
        <text
          x="56"
          y="82"
          textAnchor="middle"
          fontFamily="Instrument Serif, Times New Roman, serif"
          fontStyle="italic"
          fontSize="86"
          fill="white"
        >r</text>
      </svg>
      {withWord && (
        <span className={styles.wordmark} style={{ fontSize: size * 0.9 }}>
          reely
        </span>
      )}
    </div>
  );
});
