import { useZustandStore } from "./createStore";
import type { Dispatch, Store } from "./types";
import { useSelector } from "./useSelector";

export { createStore } from "./createStore";
export { useSelector } from "./useSelector";
export type { Dispatch } from "./types";

// `state.dispatch` is set once when the store is created and never reassigned,
// so the selector returns a stable reference and a `useShallow` wrap would be
// wasted work. Documented per audit 9 #152.
export const useDispatch = (): Dispatch => useZustandStore((state) => state.dispatch);

// Generic K (audit 12 #215): forwards the narrowed key union from the
// useSelector signature, so a call like `useStore(["route", "toasts"])`
// returns `[Pick<Store, "route" | "toasts">, Dispatch]` rather than a
// `Pick` of the full `keyof Store`. Without the generic, destructured
// callers received `Store["...everything..."]` and lost the narrowing
// that `useSelector` was already producing internally.
export const useStore = <K extends keyof Store>(keys: K[]) => {
  const dispatch = useDispatch();
  const store = useSelector(keys);
  return [store, dispatch] as const;
};

// Subscribe to a single DERIVED value (audit 16 #432). useSelector's
// key-picking + useShallow can't help when a component needs a computed
// value off a frequently-replaced object: picking "room" means failing
// shallow equality -- and re-rendering -- on every broadcast that spreads
// a new room identity (userProgress, match, join, leave). Selecting the
// computed value re-renders only when the value itself changes (zustand
// compares with Object.is).
export const useStoreComputed = <T>(selector: (state: Store) => T): T =>
  useZustandStore(selector);
