import { StrictMode } from "react";
// React 19 removed the global JSX namespace; the type now imports from
// the react package itself.
import type { JSX } from "react";
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

// Hoisted so it is not rebuilt every render. `Record<Routes, ...>` makes the
// lookup total, so no fallback branch is needed.
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

// No `--vh` shim: CSS `dvh` tracks the collapsing mobile address bar on its
// own and is supported by every browser reely targets.

window.addEventListener("keyup", (e) => {
  if (e.key === "Tab") {
    document.body.classList.add("show-focus-ring");
  }
});

window.addEventListener("mouseup", () => {
  document.body.classList.remove("show-focus-ring");
});
