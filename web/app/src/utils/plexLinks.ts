import { useEffect, useState } from "react";
import type { Media } from "../../../../types/reely";

export interface PlexLinkSet {
  /** The "Open in Plex" URL. Local Plex web UI when the LAN is reachable,
   * app.plex.tv otherwise. */
  webUrl: string;
}

/**
 * Build the "Open in Plex" link for a media item.
 *
 * Undefined when the Plex server id isn't known yet; callers render nothing.
 *
 * `preferLocal` plus a known `plexBaseUrl` links straight to the local server
 * (no plex.tv round-trip, works offline); otherwise app.plex.tv.
 *
 * No plex:// deep link: the Plex apps open but never route the metadataKey,
 * under any scheme or key encoding. The web page offers "open in app" anyway.
 */
// Scheme allowlist for the server-supplied plexBaseUrl: a `javascript:` or
// `data:` value would otherwise be concatenated into a clickable link.
// Anything but http/https falls back to app.plex.tv.
const isSafePlexBaseUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

export const buildPlexLinks = (
  media: Media,
  serverId: string | undefined,
  plexBaseUrl?: string,
  preferLocal?: boolean,
): PlexLinkSet | undefined => {
  if (!serverId) return undefined;
  const key = encodeURIComponent(media.plexKey);
  if (preferLocal && plexBaseUrl && isSafePlexBaseUrl(plexBaseUrl)) {
    const base = plexBaseUrl.replace(/\/$/, "");
    return {
      webUrl: `${base}/web/index.html#!/server/${serverId}/details?key=${key}`,
    };
  }
  return {
    webUrl: `https://app.plex.tv/desktop#!/server/${serverId}/details?key=${key}`,
  };
};

// One probe per page session: network topology doesn't change mid-session, so
// the result is cached and shared by every caller.
const PROBE_TIMEOUT_MS = 1500;
let probe: Promise<boolean> | undefined;
let probeBaseUrl: string | undefined;

export const probeLocalPlexReachable = (
  baseUrl: string | undefined,
): Promise<boolean> => {
  if (!baseUrl) return Promise.resolve(false);
  // Keyed by baseUrl so a config change mid-session re-probes.
  if (probe && probeBaseUrl === baseUrl) return probe;
  probeBaseUrl = baseUrl;
  probe = (async () => {
    try {
      // no-cors: only network-level success matters, and Plex sends no CORS
      // headers. /identity is unauthenticated and fast.
      await fetch(`${baseUrl.replace(/\/$/, "")}/identity`, {
        method: "GET",
        mode: "no-cors",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return true;
    } catch {
      // Timeout, network error, or mixed-content block: unusable either way.
      return false;
    }
  })();
  return probe;
};

/** Reachability probe as a hook; undefined while still detecting. */
export const useLocalPlexReachable = (
  baseUrl: string | undefined,
): boolean | undefined => {
  const [state, setState] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    probeLocalPlexReachable(baseUrl).then((ok) => {
      if (!cancelled) setState(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);
  return state;
};
