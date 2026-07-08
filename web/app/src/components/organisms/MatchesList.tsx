import { useMemo } from "react";
import { useStore } from "../../store";
import { Avatar } from "../atoms/Avatar";
import { formatDuration } from "../../utils/format";
import { useEscape } from "../../hooks/useEscape";
import { buildPlexLinks, useLocalPlexReachable } from "../../utils/plexLinks";
import { posterSrc } from "../../utils/poster";
import styles from "./MatchesList.module.css";

interface MatchesListProps {
  onClose: () => void;
}

export const MatchesList = ({ onClose }: MatchesListProps) => {
  const [{ room, config }] = useStore(["room", "config"]);
  // Escape closes, matching every sibling overlay (audit 16 #455) -- the
  // convention UsersPopup documents so users don't have to remember
  // which overlays support it. This was the only one that didn't.
  useEscape(onClose);
  // Same local-Plex probe Room.tsx uses for its desktop sidebar -- without
  // this MatchesList always built app.plex.tv links even on LAN-only
  // deployments where the local Plex web UI is reachable. Regression vs.
  // 0.3.20; flagged by audit 9 #102 and audit 10 #132 independently.
  const localPlexReachable = useLocalPlexReachable(config?.plexBaseUrl);
  const matches = room?.matches ?? [];
  const sorted = useMemo(
    () => [...matches].sort((a, b) => b.matchedAt - a.matchedAt),
    [matches],
  );

  return (
    <div className={styles.overlay}>
      <div className={styles.header}>
        <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M10 4l-4 4 4 4"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className={styles.titleBlock}>
          <span className={styles.titleLabel}>Your shortlist</span>
          <h1 className={styles.title}>
            {sorted.length}{" "}
            <span className={styles.titleAccent}>matches</span>
          </h1>
        </div>
        <div className={styles.spacer} />
      </div>

      {sorted.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No matches yet.</p>
          <p className={styles.emptyText}>
            Keep swiping. Movies two or more of you love will land here.
          </p>
        </div>
      ) : (
        <div className={styles.body}>
          {sorted.map((match, i) => {
            const m = match.media;
            // Cache the link locally -- previously called twice per row
            // (once to gate, once to read .webUrl). Audit 10 #132.
            const plexLink = buildPlexLinks(
              m,
              config?.plexServerId,
              config?.plexBaseUrl,
              localPlexReachable === true,
            );
            return (
              <div
                key={m.id}
                className={styles.matchRow}
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <div className={styles.poster}>
                  {m.posterUrl ? (
                    <img
                      className={styles.posterImg}
                      src={posterSrc(m.posterUrl)}
                      alt={m.title}
                      loading="lazy"
                    />
                  ) : (
                    <div className={styles.posterPlaceholder}>{m.title}</div>
                  )}
                </div>

                <div className={styles.info}>
                  <div>
                    <p className={styles.matchTitle}>{m.title}</p>
                    <p className={styles.matchMeta}>
                      {[
                        m.year,
                        m.duration ? formatDuration(m.duration) : null,
                        m.rating ? `★ ${m.rating}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {m.genres.length > 0 && (
                      <div className={styles.genrePills}>
                        {m.genres.slice(0, 2).map((g) => (
                          <span key={g} className={styles.genrePill}>
                            {g}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className={styles.matchFooter}>
                    <div className={styles.avatarRow}>
                      {match.users.slice(0, 3).map((name, idx) => (
                        <div
                          key={name}
                          className={`${styles.avatarWrap}${idx > 0 ? ` ${styles.avatarOffset}` : ""}`}
                        >
                          <div className={styles.avatarScale}>
                            <Avatar userName={name} progress={0} />
                          </div>
                        </div>
                      ))}
                    </div>
                    {plexLink && (
                      <a
                        href={plexLink.webUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.plexLink}
                      >
                        Plex
                        <svg
                          width="9"
                          height="9"
                          viewBox="0 0 16 16"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="M6 3h7v7M13 3L4 12"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                        </svg>
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
