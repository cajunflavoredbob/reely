import type { Media } from "../../../../../types/reely";
import { useStore } from "../../store";
import { buildPlexLinks, useLocalPlexReachable } from "../../utils/plexLinks";
import { isIOS } from "../../utils/platform";
import styles from "./PlexLinks.module.css";

interface PlexLinksProps {
  media: Media;
}

// "Open in Plex" link: local Plex web UI when the browser can reach it on the
// LAN, app.plex.tv otherwise. Renders nothing until the config message lands.
export const PlexLinks = ({ media }: PlexLinksProps) => {
  const [{ config }] = useStore(["config"]);
  const localReachable = useLocalPlexReachable(config?.plexBaseUrl);
  const links = buildPlexLinks(
    media,
    config?.plexServerId,
    config?.plexBaseUrl,
    localReachable === true,
  );
  if (!links) return null;

  return (
    // stopPropagation so the click doesn't reach parent overlays (MatchMoment's
    // onClick dismisses the celebration). No semantics of its own: it wraps a
    // real <a>.
    // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper.
    // biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation wrapper.
    <div className={styles.row} onClick={(e) => e.stopPropagation()}>
      <a
        className={styles.link}
        href={links.webUrl}
        target={isIOS ? "_self" : "_blank"}
        rel="noopener noreferrer"
      >
        Open in Plex
      </a>
    </div>
  );
};
