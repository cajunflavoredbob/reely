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

// memo: static mark with stable props; skips the SVG build on parent renders.
export const Logo = memo(({ size = 28, withWord = true }: LogoProps) => {
  // SVG ids are global: without a unique one, a second Logo's fill resolves to
  // the first Logo's gradient and breaks when that one unmounts.
  const gradId = useId();
  return (
    <div className={styles.root}>
      {/* aria-hidden: the wordmark below carries the label for screen readers. */}
      <svg width={size} height={size} viewBox={MARK_VIEWBOX} fill="none" aria-hidden="true">
        <defs>
          {/* Endpoints are percentages, i.e. the objectBoundingBox default.
              Not userSpaceOnUse: bounding-box shears the gradient axis by the
              card's 300x420 aspect, which is what matches the favicon. */}
          <linearGradient id={gradId} {...GRADIENT}>
            {GRADIENT_STOPS.map((stop) => (
              <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
            ))}
          </linearGradient>
        </defs>
        {/* Fanned card stack. Geometry is generated from
            docs/branding/reely-logo.svg by scripts/gen-brand.mjs. */}
        <g transform={MARK_TRANSFORM}>
          {BACK_CARDS.map((back) => (
            <g key={back.rotate} transform={back.rotate}>
              {/* back.rect, not CARD: back cards carry their own geometry. */}
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
