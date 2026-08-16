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
| `reely-logo.svg` | Vector source for the square mark: fanned card stack, transparent background, outlined Instrument Serif italic "r" (no font dependency). Edit here; re-export PNGs from this. |
| `reely-lockup.svg` | README header lockup: the mark plus an outlined gradient "reely" wordmark. Transparent; one file works on light and dark surfaces, so no `<picture>` variants are needed. |
| `reely-logo-1000.png` | **Docker Hub repository avatar.** 1000x1000, transparent RGBA. Upload via the Docker Hub web UI (Repository -> Settings -> upload image). Well under the 1 MB cap. |
| `reely-logo-512.png` | Unraid icon URL target and general-purpose export. Transparent. |
| `reely-logo-32-preview.png` | 32x32 stress render verifying the mark holds at the smallest Docker Hub list size. Reference only. |

## Unraid container icon

Unraid's Docker container "Icon URL" field expects a direct
PNG URL. Use the stable raw URL of the 512x512 export:

    https://raw.githubusercontent.com/cajunflavoredbob/reely/main/docs/branding/reely-logo-512.png

The GitHub user-attachments CDN URLs (the trick where you
drag-drop an image into a draft issue comment, then cancel)
do NOT work for Unraid when the source repo is private --
GitHub returns 403 to anonymous fetches in that case
(verified the hard way; the Unraid webgui logged "Could
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

- Mark: fanned card-stack motif (a hand mid-swipe) with the top card carrying the warm coral / sunset gradient that lines up with the app's `--ry-*` palette. Back cards are muted terracotta / amber solids chosen to read on both light and dark surfaces.
- Type: Instrument Serif Italic (the app's display typeface), converted to outlined paths in both SVGs, so rendering never depends on the viewer having the font.
- Backgrounds are transparent everywhere; there is no separate light/dark variant. The in-app PWA icons under `web/app/static/icons/` are a separate set and stay as-is until intentionally refreshed.
