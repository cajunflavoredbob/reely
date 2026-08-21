import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { memo } from './util/memo';

// Reads VERSION from the project root: the source of truth for the app
// version, kept in step with package.json. Memoized; it can't change at runtime.
export const getVersion = memo(async (): Promise<string> => {
  const content = await readFile(join(process.cwd(), 'VERSION'), 'utf-8');
  return content.trim();
});
