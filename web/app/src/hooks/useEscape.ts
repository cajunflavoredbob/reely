import { useEffect } from "react";

// Window-level Escape listener with an optional enabled gate.
//
// The handler is captured in the effect's closure, so the listener swaps every
// render unless the caller memoizes it. Harmless for a single idempotent
// action like Escape.
export const useEscape = (handler: () => void, enabled = true) => {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handler();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handler, enabled]);
};
