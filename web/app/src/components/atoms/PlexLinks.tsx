import type { Media } from "../../../../../types/reely";
import { useStore } from "../../store";
import { buildPlexLinks, useLocalPlexReachable } from "../../utils/plexLinks";
import { isIOS } from "../../utils/platform";
import styles from "./PlexLinks.module.css";

interface PlexLinksProps {
  media: Media;
}

// "Open in Plex" link. Routes directly to the local Plex web UI when the
// browser can reach it on the LAN, falls back to app.plex.tv otherwise.
// Renders nothing until the Plex server id has arrived in the config message.
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
    // stopPropagation wrapper: prevents clicks on "Open in Plex" from
    // bubbling up to parent overlays (e.g. MatchMoment's overlay
    // onClick dismisses the match celebration). No own interactive
    // semantics -- it's a layout container around a real <a>.
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
