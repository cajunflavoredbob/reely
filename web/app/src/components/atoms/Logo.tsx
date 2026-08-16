import { memo, useId } from "react";
import styles from "./Logo.module.css";

interface LogoProps {
  size?: number;
  withWord?: boolean;
}

// The italic Instrument Serif 'r', pre-outlined to a path so the mark
// renders identically before (or without) the webfont loading, and
// pixel-matches the external brand assets in docs/branding/.
const R_PATH =
  "M65.10 500L39.68 500Q31 500 32.86 491.94L91.76 244.56Q94.86 230.92 92.69 223.17Q90.52 215.42 81.22 215.42Q70.06 215.42 56.73 231.85Q43.40 248.28 26.66 294.16Q24.18 302.22 17.98 302.22Q8.68 302.22 13.02 291.06Q26.66 248.28 41.85 224.10Q57.04 199.92 72.54 190Q88.04 180.08 101.06 180.08Q121.52 180.08 130.20 195.27Q138.88 210.46 130.82 245.18L124 274.32Q123.38 278.66 125.86 279.28Q128.34 279.90 130.20 276.18Q153.76 222.24 172.98 201.16Q192.20 180.08 217 180.08Q233.74 180.08 242.11 189.07Q250.48 198.06 250.48 213.56Q250.48 229.06 243.04 238.36Q235.60 247.66 223.82 247.66Q213.90 247.66 209.56 242.70Q205.22 237.74 203.05 231.23Q200.88 224.72 198.40 219.76Q195.92 214.80 190.34 214.80Q181.04 214.80 166.16 238.36Q151.28 261.92 134.23 301.91Q117.18 341.90 101.37 391.50Q85.56 441.10 73.78 493.18Q71.92 500 65.10 500";

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
      <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden="true">
        <defs>
          <linearGradient
            id={gradId}
            x1="106"
            y1="46"
            x2="406"
            y2="466"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor="#FF4E7E" />
            <stop offset="50%" stopColor="#FF6A4D" />
            <stop offset="100%" stopColor="#FFB347" />
          </linearGradient>
        </defs>
        {/* Fanned card stack (a hand mid-swipe); matches
            docs/branding/reely-logo.svg. Back cards are muted solids
            that read on light and dark surfaces alike. */}
        <g transform="rotate(-16 256 470)">
          <rect x="106" y="46" width="300" height="420" rx="36" fill="#C96F52" opacity="0.55" />
        </g>
        <g transform="rotate(-8 256 470)">
          <rect x="106" y="46" width="300" height="420" rx="36" fill="#E39A63" opacity="0.75" />
        </g>
        <rect x="106" y="46" width="300" height="420" rx="36" fill={`url(#${gradId})`} />
        <g transform="translate(125 -80)">
          <path d={R_PATH} fill="#ffffff" />
        </g>
      </svg>
      {withWord && (
        <span className={styles.wordmark} style={{ fontSize: size * 0.9 }}>
          reely
        </span>
      )}
    </div>
  );
});
