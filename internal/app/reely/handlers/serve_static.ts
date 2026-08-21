import { join, sep } from 'node:path';
import express, { type RequestHandler } from 'express';

// Vite content-hashes everything under assets/, so those are safely immutable.
// The rest (sw.js, manifest, icons) keeps the default revalidation: a
// long-lived sw.js would stall PWA updates for a year. index.html never
// reaches here.
export const setStaticHeaders = (
  res: { setHeader(name: string, value: string): void },
  filePath: string,
): void => {
  if (filePath.includes(`${sep}assets${sep}`)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
};

// index: false so index.html goes to the template handler, which injects
// rootPath, version, and lang at request time.
export const handler: RequestHandler = express.static(
  join(process.cwd(), 'dist', 'web'),
  { index: false, setHeaders: setStaticHeaders },
);
