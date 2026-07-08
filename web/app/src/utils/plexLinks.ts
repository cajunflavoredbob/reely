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
 * Returns undefined when the Plex server id isn't known yet (config message
 * not received, or a non-Plex provider) -- callers should render nothing in
 * that case.
 *
 * When `preferLocal` is true AND a `plexBaseUrl` is known, builds a link
 * directly to the local Plex server's web UI (no plex.tv round-trip,
 * works without internet). Otherwise falls back to the app.plex.tv web
 * URL, which works from anywhere with internet.
 *
 * The plex:// app deep link was dropped in 0.3.1 after device testing: on
 * both iOS and Android it opens the Plex app but never navigates to the
 * item -- the Plex apps don't route the metadataKey, regardless of scheme
 * (preplay/play) or key encoding. The web URLs reliably land on the movie
 * page; Plex's own page surfaces an "open in app" affordance from there.
 */
// Scheme allowlist for the server-provided plexBaseUrl (audit 13 #306).
// The value arrives via the WS `config` frame from a server we trust,
// but defense-in-depth: a future server bug or man-in-the-middle could
// supply `javascript:foo` or `data:text/html,...` and our concatenation
// would build a clickable link with that scheme. Filter to http/https
// only -- anything else falls back to the app.plex.tv URL, which is
// always safe.
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

// Probe singleton: one probe per page session. Network topology doesn't
// change mid-session, so a single result is cached and shared by every
// caller. Returns true if the local Plex base URL appears reachable from
// the browser (the LAN case), false otherwise (WAN, mixed-content blocked,
// Plex down).
const PROBE_TIMEOUT_MS = 1500;
let probe: Promise<boolean> | undefined;
let probeBaseUrl: string | undefined;

export const probeLocalPlexReachable = (
  baseUrl: string | undefined,
): Promise<boolean> => {
  if (!baseUrl) return Promise.resolve(false);
  // Cache by baseUrl: if the server's config changes (unlikely mid-session
  // but possible), re-probe.
  if (probe && probeBaseUrl === baseUrl) return probe;
  probeBaseUrl = baseUrl;
  probe = (async () => {
    try {
      // mode: no-cors so we don't fail on Plex not sending CORS headers --
      // we only need to know whether the request succeeded at the network
      // level. /identity is unauthenticated and replies quickly.
      await fetch(`${baseUrl.replace(/\/$/, "")}/identity`, {
        method: "GET",
        mode: "no-cors",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return true;
    } catch {
      // Timeout, network error, or mixed-content block (reely over https +
      // Plex over http). Either way the local URL is unusable from this
      // browser; fall back to app.plex.tv.
      return false;
    }
  })();
  return probe;
};

/**
 * React hook for the local-Plex reachability probe. Returns:
 *   - undefined while detecting (use the web URL as a safe default),
 *   - true when the local Plex base URL is reachable,
 *   - false when it isn't.
 */
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
