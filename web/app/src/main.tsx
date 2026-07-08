import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./main.css";

import { LoginScreen } from "./components/screens/Login";
import { RoomScreen } from "./components/screens/Room";
import { Loading } from "./components/screens/Loading";
import { ToastList } from "./components/atoms/Toast";
import { ConfigScreen } from "./components/screens/Config";
import type { Routes } from "./types";
import { createStore, useSelector, useDispatch } from "./store";

// Initialize the WS client and wire up the Zustand store before rendering
createStore();

// Route-to-component table. Hoisted out of the component body so it isn't
// reconstructed every render. `Record<Routes, ...>` guarantees a key for
// every Routes union member, so the lookup `ROUTES[route]` is total -- the
// fallback `<p>No route for ...</p>` branch the prior code carried was
// unreachable per the type system (audit 9 #119).
const ROUTES: Record<Routes, () => JSX.Element> = {
  loading: Loading,
  login: LoginScreen,
  room: RoomScreen,
  config: ConfigScreen,
};

const App = () => {
  const { route = "loading", toasts } = useSelector([
    "route",
    "toasts",
  ]);

  const dispatch = useDispatch();

  const CurrentComponent = ROUTES[route];

  return (
    <>
      <CurrentComponent />
      <ToastList
        toasts={toasts}
        removeToast={(toast) =>
          dispatch({ type: "removeToast", payload: toast })}
      />
    </>
  );
};

// The #app mount-point is in index.html; React 18's createRoot crashes
// loudly if it's missing. The non-null assertion is the right type-
// system shape: a missing #app means a build/template misconfiguration
// (not a runtime condition to defend against).
// biome-ignore lint/style/noNonNullAssertion: bootstrap mount-point invariant from index.html.
createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// `--vh` JS shim removed in 0.4.6 (audit 10 #171). CSS `dvh` (dynamic
// viewport height) is supported across every browser reely targets
// (Safari 15.4+, Chrome 108+, Firefox 101+; all 3+ years old) and
// updates automatically as the mobile address bar collapses / expands,
// which is exactly what the JS was emulating with a resize listener +
// `setProperty('--vh', ...)`. Consumers in CSS now use `100dvh` / `Nvh`
// directly (see main.css, Layout.module.css, Card.module.css,
// CardStack.module.css).

window.addEventListener("keyup", (e) => {
  if (e.key === "Tab") {
    document.body.classList.add("show-focus-ring");
  }
});

window.addEventListener("mouseup", () => {
  document.body.classList.remove("show-focus-ring");
});
