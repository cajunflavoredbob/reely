import { memo } from "react";
import { useStore } from "../../store";
import type { TranslationKey } from "../../../../../types/reely";

interface TranslationProps {
  name: TranslationKey;
  context?: Record<string, string>;
}

/**
 * A simple interpolate function. Single-pass: the function-replacer form
 * opts out of String.replace's $&/$1 back-reference interpretation, so a
 * translation value containing "$&" can't be misexpanded. A missing key
 * leaves its ${key} placeholder visible rather than substituting the
 * literal string "undefined".
 *
 * Charset matches the server-side `template.ts` interpolate (also accepts
 * dotted paths like `${user.name}`) so translations can use the same
 * placeholder convention regardless of which side resolves them. A dotted
 * key is looked up flat in `context` -- the server-side walker isn't
 * needed here because frontend context objects are always flat.
 *
 * @example interpolate("foo ${bar} baz", { bar: "abc" }) => "foo abc baz"
 */
const interpolate = (text: string, context: Record<string, string>): string =>
  // Explicit `a-zA-Z` rather than `a-z` + `/i` -- audit 9 #110 follow-up:
  // the lowercase-only char class with the `/i` flag worked but read
  // like a bug. Matches the server-side template.ts regex.
  text.replace(
    /\$\{([a-zA-Z0-9_.]+)\}/g,
    (full, name: string) => context[name] ?? full,
  );

export const Tr = memo(({ name, context }: TranslationProps) => {
  const [{ translations }] = useStore(["translations"]);
  const translation = translations?.[name];

  if (translation && context) {
    return <>{interpolate(translation, context)}</>;
  }

  return <>{translation ?? name}</>;
});
