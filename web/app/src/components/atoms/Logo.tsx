import { memo, useId } from "react";
import styles from "./Logo.module.css";
import {
  BACK_CARDS,
  CARD,
  GLYPH_FILL,
  GLYPH_PATH,
  GLYPH_TRANSFORM,
  GRADIENT,
  GRADIENT_STOPS,
  MARK_TRANSFORM,
  MARK_VIEWBOX,
} from "./markGeometry";

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
      <svg width={size} height={size} viewBox={MARK_VIEWBOX} fill="none" aria-hidden="true">
        <defs>
          {/* Endpoints come from the master, so they cannot drift. They are
              percentages, i.e. the objectBoundingBox default. An earlier
              hand-written copy of this component used userSpaceOnUse with the
              same numbers, which is NOT equivalent: the bounding-box form
              shears the gradient's axis by the card's 300x420 aspect, so the
              in-app mark ran its gradient at a different angle than the
              favicon beside it. */}
          <linearGradient id={gradId} {...GRADIENT}>
            {GRADIENT_STOPS.map((stop) => (
              <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
            ))}
          </linearGradient>
        </defs>
        {/* Fanned card stack (a hand mid-swipe). Geometry is generated from
            docs/branding/reely-logo.svg by scripts/gen-brand.mjs, so this
            cannot drift from the favicon and PWA icons. */}
        <g transform={MARK_TRANSFORM}>
          {BACK_CARDS.map((back) => (
            <g key={back.rotate} transform={back.rotate}>
              {/* back.rect, not CARD: the back cards carry their own geometry
                  in the master, and spreading the top card's rect over them
                  meant a master edit to a back card never reached the app. */}
              <rect {...back.rect} fill={back.fill} opacity={back.opacity} />
            </g>
          ))}
          <rect {...CARD} fill={`url(#${gradId})`} />
          <g transform={GLYPH_TRANSFORM}>
            <path d={GLYPH_PATH} fill={GLYPH_FILL} />
          </g>
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
