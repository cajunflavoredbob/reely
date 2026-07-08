# Reely branding assets

External-facing brand artifacts. Distinct from `web/app/static/icons/`,
which holds the PWA / favicon / Apple-touch icons that ship inside the
built app and are wired by `manifest.webmanifest`. The assets here are
for off-app contexts: Docker Hub, README headers, future docs, social
share images, etc.

Vector source is the canonical artifact -- the PNGs are exports for
contexts that require raster.

| File | Use |
|---|---|
| `reely-logo.svg` | Vector source. Edit here if anything ever changes; re-export PNGs from this. Uses an inline `linearGradient` and an Instrument Serif `<text>` element with a Times New Roman fallback (so it renders sanely without the font). |
| `reely-logo-1000.png` | **Docker Hub repository avatar.** 1000×1000, dark `#000` background, transparent-safe. Upload via the Docker Hub web UI (Repository -> Settings -> upload image). 72 KB, well under the 1 MB cap. |
| `reely-logo-512.png` | Convenience export. Drop-in for any future PWA icon refresh (would replace `web/app/static/icons/icon-512.png` -- but that swap is not done here; the PWA icons stay as-is until intentionally refreshed). |
| `reely-logo-light-1000.png` | Same mark on warm off-white. For any future README header on a light surface, light-themed docs, or social cards on a light background. |
| `reely-logo-32-preview.png` | 32×32 stress test the designer included to verify the mark holds at the smallest Docker Hub render context (mobile / dense list views). Not for use; reference only. |

## Unraid container icon

Unraid's Docker container "Icon URL" field expects a direct
PNG URL. Use the 512×512 export:

- **While the repo is private (pre-1.0)** -- self-hosted at:

      http://www.cajunflavoredbob.com/reely-logo-512.png

  (HTTP is fine; Unraid's icon-download path doesn't require
  HTTPS. If you have HTTPS available, use it.)

- **Once the repo is public**, swap to the stable raw URL:

      https://raw.githubusercontent.com/cajunflavoredbob/reely/main/docs/branding/reely-logo-512.png

The GitHub user-attachments CDN URLs (the trick where you
drag-drop an image into a draft issue comment, then cancel)
do NOT work for Unraid when the source repo is private --
GitHub returns 403 to anonymous fetches in that case
(verified the hard way; server1's webgui logged "Could
not download icon" when reely was the private source).
The trick only works when the source issue/comment/gist
lives in a PUBLIC repo, in which case the CDN URL stays
valid forever even from a cancelled draft. Stopgap options
when private:
- Self-host (chosen here) on any HTTP-reachable domain
- Imgur (anonymous upload, direct image link)
- Public gist with the PNG attached + submitted

Unraid caches icons aggressively -- after pasting a new URL,
Settings -> Docker -> "Force Update Applications" if the icon
doesn't refresh.

## Brand notes

- Mark: card-stack motif (echoes the swipe interaction) with the top card carrying the warm coral / sunset gradient that lines up with the app's `--ry-*` palette.
- Wordmark stand-in: italic "r" in Instrument Serif (the app's display typeface).
- Background of the dark variant is pure `#000`, very close to the app's `theme_color: #0a0604` but not identical. Imperceptible on most displays; matters only if these assets are ever reused as PWA icons against the app chrome.
