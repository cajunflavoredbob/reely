import { useEffect } from "react";

// Window-level Escape-key listener bound to a handler, with an optional
// enabled gate (audit 13 #324). Extracted from inline duplicates in
// Room, MatchMoment, and UsersPopup. Each of those registered the same
// keydown listener with the same teardown -- 6 lines of boilerplate per
// site that's now one hook call.
//
// `enabled` short-circuits the listener installation entirely when
// false; the prior Room.tsx pattern used an early `if (!filterPanelOpen)
// return;` inside the effect body, which is functionally equivalent
// (the effect re-runs when the dep changes and either installs or
// skips). The `enabled` arg makes the intent explicit at the call site.
//
// The handler is captured in the effect's closure; pass a `useCallback`
// or accept that the listener swaps each render. For Escape -- a single,
// idempotent action -- the swap is harmless.
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
