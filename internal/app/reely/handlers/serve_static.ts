import { join, sep } from 'node:path';
import express, { type RequestHandler } from 'express';

// Vite content-hashes every bundle it emits under assets/ (filename
// changes whenever content changes), so those files are safely immutable
// (audit 16 #458). Everything else under dist/web -- sw.js, the
// manifest, icons -- keeps serve-static's default max-age=0 revalidation:
// the service worker in particular MUST stay short-lived or PWA updates
// would stall for a year. index.html never reaches this handler at all
// (template handler, no-cache).
export const setStaticHeaders = (
  res: { setHeader(name: string, value: string): void },
  filePath: string,
): void => {
  if (filePath.includes(`${sep}assets${sep}`)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
};

// Serves the compiled Vite frontend from dist/web (populated by `pnpm build`).
// index: false so the SPA shell (index.html) is always served by the template
// handler, which injects rootPath, version, and lang at request time.
export const handler: RequestHandler = express.static(
  join(process.cwd(), 'dist', 'web'),
  { index: false, setHeaders: setStaticHeaders },
);
