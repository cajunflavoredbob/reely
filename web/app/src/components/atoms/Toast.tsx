import { useEffect, useRef } from "react";

import styles from "./Toast.module.css";

export interface Toast {
  // Narrowed from `number | string` in 0.4.10 (audit 11 #182 / audit 12
  // #266): every producer yields a string (`nextToastId`, the literal
  // "connection-failure"), and consumers defensively did `String(t.id)`
  // anyway. The narrower type drops the conversion overhead + the false
  // flexibility.
  id: string;
  message: string;
  showTimeMs?: number;
  appearance?: "Success" | "Failure";
}

interface ToastProps {
  toasts?: Toast[];
  removeToast: (toast: Toast) => void;
}

export const ToastList = ({ toasts, removeToast }: ToastProps) => {
  // Track which toast ids already have a pending removal timer so we don't
  // restart timers every render. The prior implementation spawned a fresh
  // setTimeout for toasts[0] on every render of the toasts array.
  //
  // Lazy-init pattern (audit 13 #310): the prior `useRef(new Map(...))`
  // constructed a fresh Map on EVERY render even though React keeps only
  // the first one. Cheap individually but a per-render allocation across
  // the lifetime of the component. Defer construction to the first read.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>> | null>(null);
  const getTimers = () => {
    if (timersRef.current === null) {
      timersRef.current = new Map<string, ReturnType<typeof setTimeout>>();
    }
    return timersRef.current;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: getTimers is a stable closure over the ref; including it would just satisfy the rule (no behavior change), and the linter doesn't realize it's a render-stable accessor.
  useEffect(() => {
    const currentIds = new Set(toasts?.map((t) => t.id) ?? []);
    // Clean up timers for toasts that were removed externally (e.g. by
    // click). Without this the setTimeout would fire later as a no-op
    // against an already-removed toast, but the entry would stay in
    // getTimers() until the component unmounts -- a slow leak across
    // long sessions (audit 10 #135).
    for (const [id, handle] of getTimers()) {
      if (!currentIds.has(id)) {
        clearTimeout(handle);
        getTimers().delete(id);
      }
    }
    toasts?.forEach((toast) => {
      if (typeof toast.showTimeMs !== "number") return;
      if (getTimers().has(toast.id)) return;
      const handle = setTimeout(() => {
        getTimers().delete(toast.id);
        removeToast(toast);
      }, toast.showTimeMs);
      getTimers().set(toast.id, handle);
    });
  }, [toasts, removeToast]);

  // Clear any pending timers if the component unmounts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount/unmount effect; getTimers is the ref-accessor (render-stable).
  useEffect(() => () => {
    // Block body (vs expression body) so the callback's return type is
    // void -- the prior `(h) => clearTimeout(h)` returned clearTimeout's
    // return value, which biome flags via useIterableCallbackReturn even
    // though forEach ignores it.
    getTimers().forEach((handle) => { clearTimeout(handle); });
    getTimers().clear();
  }, []);

  return (
    <ul className={styles.toastList}>
      {toasts?.map((toast) => (
        <li key={toast.id} className={styles[`toast${toast.appearance ?? ""}`]}>
          {toast.message}
        </li>
      ))}
    </ul>
  );
};
