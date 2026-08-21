// Shared 16-unit close-X for FilterPanel, MatchMoment, and UsersPopup.
// CardStack's is a visually distinct 24-unit path and stays inline.
interface CloseIconProps {
  // viewBox is 0 0 16 16, so the path scales to any size.
  size?: number;
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
