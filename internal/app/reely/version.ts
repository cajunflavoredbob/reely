import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { memo } from './util/memo';

/**
 * Reads the VERSION file from the project root.
 * The VERSION file is the single source of truth for the application version
 * and should match the version field in package.json. Memoized because the
 * file doesn't change at runtime and the template handler used to call this
 * on every page render.
 */
export const getVersion = memo(async (): Promise<string> => {
  const content = await readFile(join(process.cwd(), 'VERSION'), 'utf-8');
  return content.trim();
});
