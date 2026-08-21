import { useEffect, useRef } from "react";

import styles from "./Toast.module.css";

export interface Toast {
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
  // Toast ids with a pending removal timer, so renders don't restart them.
  // Lazy-init: `useRef(new Map())` would build a throwaway Map every render.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>> | null>(null);
  const getTimers = () => {
    if (timersRef.current === null) {
      timersRef.current = new Map<string, ReturnType<typeof setTimeout>>();
    }
    return timersRef.current;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: getTimers is a render-stable ref accessor; listing it changes nothing.
  useEffect(() => {
    const currentIds = new Set(toasts?.map((t) => t.id) ?? []);
    // Drop timers for toasts removed externally (e.g. by click); their entries
    // would otherwise linger in the Map until unmount.
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

  // Clear pending timers on unmount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount/unmount effect; getTimers is a render-stable ref accessor.
  useEffect(() => () => {
    // Block body keeps the return type void; the expression form returns
    // clearTimeout's value, which biome flags (useIterableCallbackReturn).
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
