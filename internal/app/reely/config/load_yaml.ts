import { readFile } from 'node:fs/promises';
import { load as parseYaml, JSON_SCHEMA } from 'js-yaml';
import type { Config } from '../../../../types/reely';
import { isRecord } from '../util/assert';
import { ConfigFileNotFoundError, ConfigMustBeRecord } from './errors';

// True when at least one line is something other than blank space, a comment,
// or a document marker. Deliberately textual: it must not depend on the parser
// surviving an empty input.
const hasSettings = (raw: string): boolean =>
  raw.split('\n').some((line) => {
    const trimmed = line.trim();
    return (
      trimmed !== '' && trimmed !== '---' && trimmed !== '...' && !trimmed.startsWith('#')
    );
  });

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

  // A file with nothing but blank lines, comments and document markers carries
  // no settings; that is not the same as being malformed. Mounting a
  // placeholder config.yaml while configuring through env vars must not kill
  // the boot, and loadConfig's throws are fatal in main.ts. Decided here rather
  // than from the parse result because js-yaml changed its answer: 4 returned
  // undefined for an empty document, 5 raises YAMLException instead.
  if (!hasSettings(raw)) return {};

  // JSON_SCHEMA narrows js-yaml's YAML 1.1 default so only true/false are
  // booleans. Otherwise `port: on` and `logLevel: y` both parse as `true`.
  const parsed = parseYaml(raw, { schema: JSON_SCHEMA });

  // A document whose only content is a literal `null` still means "no
  // settings". `~` is not a null under JSON_SCHEMA, it is the string "~", and
  // it is rejected below like any other non-mapping.
  if (parsed === undefined || parsed === null) return {};

  // isRecord accepts arrays, and a root-level list (the servers block written
  // without its key) would spread into keys "0", "1", ... that validation then
  // ignores entirely, booting to "not configured" with nothing naming the
  // file. Reject the shape here, where the path is still in hand.
  if (Array.isArray(parsed)) {
    throw new ConfigMustBeRecord(
      `${path} must be a mapping of settings, not a list. A "servers:" key is ` +
        'probably missing above the list.',
    );
  }

  isRecord(parsed, path, ConfigMustBeRecord);

  return parsed as Partial<Config>;
};
