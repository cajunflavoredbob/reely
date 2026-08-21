import { useZustandStore } from "./createStore";
import type { Dispatch, Store } from "./types";
import { useSelector } from "./useSelector";

export { createStore } from "./createStore";
export { useSelector } from "./useSelector";
export type { Dispatch } from "./types";

// `state.dispatch` is never reassigned, so the reference is stable and a
// `useShallow` wrap would be wasted work.
export const useDispatch = (): Dispatch => useZustandStore((state) => state.dispatch);

// The generic forwards useSelector's narrowed key union, so a caller gets
// `Pick<Store, "route" | "toasts">` rather than a Pick of all of `keyof Store`.
export const useStore = <K extends keyof Store>(keys: K[]) => {
  const dispatch = useDispatch();
  const store = useSelector(keys);
  return [store, dispatch] as const;
};

// Subscribe to a derived value. Picking "room" re-renders on every broadcast
// that spreads a new room identity; selecting the computed value re-renders
// only when that value changes.
export const useStoreComputed = <T>(selector: (state: Store) => T): T =>
  useZustandStore(selector);
