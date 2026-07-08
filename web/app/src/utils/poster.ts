// Poster URLs from the server are root-relative (/api/poster/...). Under a
// reverse-proxy mount (rootPath / X-Forwarded-Prefix) they must be prefixed
// with document.body.dataset.rootPath, or the browser resolves them against
// the proxy origin and the image 404s. Every poster <img> goes through here.
export const posterSrc = (
  posterUrl: string | undefined,
): string | undefined =>
  posterUrl ? `${document.body.dataset.rootPath ?? ""}${posterUrl}` : undefined;
