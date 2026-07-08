import { useShallow } from "zustand/react/shallow";
import { useZustandStore } from "./createStore";
import type { Store } from "./types";

export const useSelector = <K extends keyof Store>(keys: Array<K>): Pick<Store, K> => {
  return useZustandStore(
    useShallow((state) =>
      keys.reduce((acc, key) => {
        (acc as Pick<Store, K>)[key] = (state as Store)[key];
        return acc;
      }, {} as Pick<Store, K>)
    ),
  );
};
