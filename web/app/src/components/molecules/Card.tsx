import { useState } from "react";
import type { Media } from "../../../../../types/reely";
import { formatDuration } from "../../utils/format";
import { posterSrc } from "../../utils/poster";
import { PlexLinks } from "../atoms/PlexLinks";
import { isIOS } from "../../utils/platform";
import styles from "./Card.module.css";

export interface CardProps {
  href?: string;
  media: Media;
}

export const Card = ({ media, href }: CardProps) => {
  const [showMoreInfo, setShowMoreInfo] = useState(false);
  // Holds the src that failed rather than a boolean, so a card re-rendered with
  // a different poster starts trusting it again without a reset effect.
  const [failedPoster, setFailedPoster] = useState<string | undefined>(undefined);

  // Single src, no srcSet: the poster handler proxies Plex artwork as-is and
  // ignores a width param, so variants would refetch the same full-size image.
  const poster = posterSrc(media.posterUrl);

  // A deleted or re-scanned Plex item, or a rate-limited poster request, would
  // otherwise leave the browser's broken-image glyph over the card; dropping
  // the img falls back to the card's black background and title overlay.
  const posterBroken = poster !== undefined && poster === failedPoster;

  // `year` is optional on Media, and a template literal stringifies a missing
  // one as the literal "undefined", so the suffix is built conditionally.
  const yearSuffix = media.type === "movie" && media.year ? ` (${media.year})` : "";
  const mediaTitle = `${media.title}${yearSuffix}`;

  const inner = (
    <>
      {poster && !posterBroken && (
        <img
          className={styles.poster}
          src={poster}
          alt={`${media.title} poster`}
          draggable={false}
          onError={() => setFailedPoster(poster)}
        />
      )}
      <div className={styles.grain} />

      {!showMoreInfo && (
        <div className={styles.titleContainer}>
          <p className={styles.title}>{mediaTitle}</p>
          {media.year && (
            <p className={styles.meta}>
              {media.year}
              {media.duration ? ` · ${formatDuration(media.duration)}` : ""}
              {media.rating ? ` · ★ ${media.rating}` : ""}
            </p>
          )}
        </div>
      )}

      {showMoreInfo && (
        <div className={styles.moreInfo}>
          {media.genres.length > 0 && (
            <div className={styles.genrePills}>
              {media.genres.map((g) => (
                <span key={g} className={styles.genrePill}>{g}</span>
              ))}
            </div>
          )}
          <p className={styles.moreInfoTitle}>{mediaTitle}</p>
          <p className={styles.moreInfoMeta}>
            {[
              media.year,
              media.duration ? formatDuration(media.duration) : null,
              media.rating ? `★ ${media.rating}` : null,
              media.contentRating,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {media.description && (
            <p className={styles.moreInfoDescription}>{media.description}</p>
          )}
          <PlexLinks media={media} />
        </div>
      )}

      {/* Info toggle: swipe cards only; link cards navigate directly. */}
      {!href && (
        <button
          type="button"
          className={styles.infoButton}
          aria-label={showMoreInfo ? "Show title" : "More info"}
          onClick={(e) => {
            e.preventDefault();
            setShowMoreInfo((v) => !v);
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 7v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="5" r="0.8" fill="currentColor" />
          </svg>
        </button>
      )}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        className={styles.linkCard}
        target={isIOS ? "_self" : "_blank"}
        rel="noopener noreferrer"
      >
        {inner}
      </a>
    );
  }

  return <div className={styles.card}>{inner}</div>;
};
