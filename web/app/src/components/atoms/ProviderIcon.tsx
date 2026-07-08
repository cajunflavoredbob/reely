import { memo } from "react";

interface ProviderIconProps {
  type?: string;
  size?: number;
}

// All ProviderIcon SVGs are aria-hidden: the provider identity (Plex /
// future Emby / Jellyfin) is conveyed by surrounding text wherever the
// icon appears. Treating these as pure visual decoration matches how
// screen readers should consume them.
const PlexIcon = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <circle cx="10" cy="10" r="10" fill="#000" />
    {/* Two right-pointing chevron rings -- the Plex mark */}
    <path d="M4 5L9 10L4 15H5.5L10.5 10L5.5 5H4Z" fill="#EBAF00" />
    <path d="M8.5 5L13.5 10L8.5 15H10L15 10L10 5H8.5Z" fill="#EBAF00" />
  </svg>
);

// React.memo (audit 14 #334): ProviderIcon's props are stable across
// most renders (the provider type is fixed for the session). Skipping
// the SVG re-construction is a free win.
export const ProviderIcon = memo(({ type = "plex", size = 20 }: ProviderIconProps) => {
  if (type === "plex") return <PlexIcon size={size} />;

  // Placeholder for future providers (emby, jellyfin, etc.)
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="10" fill="#EBAF00" />
      <text
        x="10"
        y="14"
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fill="#1a1000"
        fontFamily="system-ui, sans-serif"
      >
        {type.charAt(0).toUpperCase()}
      </text>
    </svg>
  );
});
