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
    // Surface a typed error only for the genuine "file does not exist" case.
    // Other I/O errors (EACCES, EISDIR, EIO, etc.) should propagate as-is so
    // operators see the actual cause rather than a misleading not-found
    // message that masks permission or hardware issues.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigFileNotFoundError(`${path} does not exist`);
    }
    throw err;
  }

  // JSON_SCHEMA (audit 12 #235) narrows js-yaml's YAML 1.1 default to
  // the JSON-compatible types: strings, numbers, booleans (true/false
  // only -- NOT yes/no/on/off/y/n), arrays, objects, null. Without
  // this, `port: on` parses as `true` and `LOG_LEVEL: y` parses as
  // `true` -- both gibberish for our config but accepted into the
  // partial config object until the validator catches them.
  const parsed = parseYaml(raw, { schema: JSON_SCHEMA });
  isRecord(parsed, path);

  return parsed as Partial<Config>;
};
