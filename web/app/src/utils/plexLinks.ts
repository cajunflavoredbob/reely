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

// The result is cached and shared by every caller, but only for as long as the
// network it describes can be assumed unchanged: a phone that leaves the house
// Wi-Fi mid-session would otherwise point every "Open in Plex" link at a LAN
// address it can no longer reach, for the life of the tab.
const PROBE_TIMEOUT_MS = 1500;
const PROBE_TTL_MS = 60_000;
let probe: Promise<boolean> | undefined;
let probeBaseUrl: string | undefined;
let probedAt = 0;

// Expires the cache rather than dropping it, so the first of the N mounted
// link components to react to an online/offline event re-probes and the rest
// join that one probe instead of each firing their own.
const markProbeStale = () => {
  probedAt = 0;
};

export const probeLocalPlexReachable = (
  baseUrl: string | undefined,
): Promise<boolean> => {
  if (!baseUrl) return Promise.resolve(false);
  // Keyed by baseUrl so a config change mid-session re-probes.
  if (probe && probeBaseUrl === baseUrl && Date.now() - probedAt < PROBE_TTL_MS) {
    return probe;
  }
  probeBaseUrl = baseUrl;
  probedAt = Date.now();
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
    const run = () => {
      probeLocalPlexReachable(baseUrl).then((ok) => {
        if (!cancelled) setState(ok);
      });
    };
    run();
    // An online/offline flip means the network changed, so the cached answer is
    // worthless. Returning to a backgrounded tab only re-checks if the cache
    // has gone stale, which is the case that matters: the phone was carried off
    // the LAN (or back onto it) while the tab sat in the background.
    const reprobe = () => {
      markProbeStale();
      run();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    window.addEventListener("online", reprobe);
    window.addEventListener("offline", reprobe);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("online", reprobe);
      window.removeEventListener("offline", reprobe);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [baseUrl]);
  return state;
};
