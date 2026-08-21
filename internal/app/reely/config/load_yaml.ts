import { readFile } from 'node:fs/promises';
import { load as parseYaml, JSON_SCHEMA } from 'js-yaml';
import type { Config } from '../../../../types/reely';
import { isRecord } from '../util/assert';
import { ConfigFileNotFoundError } from './errors';

export const loadFromYaml = async (path: string): Promise<Partial<Config>> => {
  let raw: string;

  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    // Only ENOENT gets the typed error; other I/O errors propagate so a
    // permission or hardware problem isn't masked as "not found".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigFileNotFoundError(`${path} does not exist`);
    }
    throw err;
  }

  // JSON_SCHEMA narrows js-yaml's YAML 1.1 default so only true/false are
  // booleans. Otherwise `port: on` and `logLevel: y` both parse as `true`.
  const parsed = parseYaml(raw, { schema: JSON_SCHEMA });
  isRecord(parsed, path);

  return parsed as Partial<Config>;
};
