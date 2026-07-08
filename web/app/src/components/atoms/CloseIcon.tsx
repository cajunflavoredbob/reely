// 16-unit close-X used by every dismissable surface that doesn't have a
// custom-sized icon: FilterPanel (header + tag-chip dismissals),
// MatchMoment (overlay dismiss), UsersPopup (0.5.4: switched from an
// inline offset path to this shared icon when its close button got the
// MatchMoment gradient-pill treatment -- the offset path didn't read
// well inside the pill). Extracted in 0.4.23 (audit 13 #322) -- the
// path was inlined four times verbatim, only varying by stroke width
// (2 vs 2.5) and the surrounding <button>'s aria-label.
//
// Larger close-X variant in CardStack (24-unit, M6 6l12 12M18 6L6 18)
// is visually distinct and stays inline. Sharing that would require
// either accepting arbitrary paths as props (defeats the purpose) or
// proliferating component names; not worth the indirection.
interface CloseIconProps {
  // Render size in pixels. Default 14 matches the FilterPanel header use;
  // 12 for tag-chip dismiss buttons. The SVG uses viewBox 0 0 16 16 so
  // the path scales proportionally regardless of display size.
  size?: number;
  // Default 2 matches FilterPanel header; 2.5 matches the inline tag
  // chips. Override per call site to preserve the existing visual.
  strokeWidth?: number;
  className?: string;
}

export const CloseIcon = ({ size = 14, strokeWidth = 2, className }: CloseIconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    className={className}
    aria-hidden="true"
  >
    <path
      d="M4 4l8 8M12 4l-8 8"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
    />
  </svg>
);
