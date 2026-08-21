// Server poster URLs are root-relative, so under a reverse-proxy mount they
// need the rootPath prefix or they resolve against the proxy origin and 404.
export const posterSrc = (
  posterUrl: string | undefined,
): string | undefined =>
  posterUrl ? `${document.body.dataset.rootPath ?? ""}${posterUrl}` : undefined;
