import { memo } from "react";
import { useStore } from "../../store";
import type { TranslationKey } from "../../../../../types/reely";

interface TranslationProps {
  name: TranslationKey;
  context?: Record<string, string>;
}

/**
 * Interpolates `${key}` placeholders. The function-replacer form opts out of
 * String.replace's $&/$1 back-references, so a translation containing "$&"
 * can't be misexpanded. A missing key leaves its placeholder visible.
 *
 * Charset matches server-side `template.ts`, including dotted paths. Dotted
 * keys are looked up flat: frontend context objects are never nested.
 *
 * @example interpolate("foo ${bar} baz", { bar: "abc" }) => "foo abc baz"
 */
const interpolate = (text: string, context: Record<string, string>): string =>
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
