import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { ReelyClient } from "../api/reely";
import type { ClientMessage } from "../../../../types/reely";
import { reducer, initialState } from "./reducer";
import type { Actions, ClientActions, Dispatch, Store } from "./types";

// Exhaustive ClientActions -> ReelyClient dispatch. A switch rather than
// `action.type in client`, which would also match inherited EventTarget
// methods; `default: never` fails typecheck on an unhandled variant.
const dispatchToClient = (
  client: ReelyClient,
  msg: ClientActions,
): unknown => {
  switch (msg.type) {
    case "login":             return client.login(msg.payload);
    case "logout":            return client.logout();
    case "createRoom":        return client.createRoom(msg.payload);
    case "joinRoom":          return client.joinRoom(msg.payload);
    case "joinOrCreateRoom":  return client.joinOrCreateRoom(msg.payload);
    case "leaveRoom":         return client.leaveRoom();
    case "rate":              return client.rate(msg.payload);
    case "setLocale":         return client.setLocale(msg.payload);
    case "requestFilters":    return client.requestFilters();
    case "requestFilterValues": return client.requestFilterValues(msg.payload);
    case "applyFilters":      return client.applyFilters(msg.payload);
    // UI-only: undefined makes the caller skip the catch attach.
    case "addToast":
    case "removeToast":
    case "navigate":
      return undefined;
    default: {
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
};

type ZustandStore = Store & { dispatch: Dispatch };

// Window after a disconnect in which a reconnect silently auto-rejoins the
// last room. Past it (closed laptop, changed network) re-entry is explicit.
const RECONNECT_REJOIN_WINDOW_MS = 10 * 60 * 1000;

// Singleton client; useZustandStore is populated by createStore()
let client: ReelyClient;
export let useZustandStore: UseBoundStore<StoreApi<ZustandStore>>;

// Tears down the listeners registered below. Module scope so a second
// createStore call (HMR, repeated init) aborts the prior set instead of
// double-binding.
let listenerController: AbortController | undefined;

export const createStore = () => {
  if (!client) client = new ReelyClient();
  // Tear down any listeners from a prior createStore call (HMR cycle).
  listenerController?.abort();
  listenerController = new AbortController();
  const { signal } = listenerController;

  useZustandStore = create<ZustandStore>()((set, _get) => ({
    ...initialState,
    dispatch: (action: ClientActions) => {
      const result: unknown = dispatchToClient(client, action);
      // Request methods reject on a reply timeout; toast it rather than leave
      // an unhandled rejection and a UI stuck on a reply that never arrives.
      // applyFilters also rejects when the user changed rooms mid-wait, which
      // is not a server problem, so a UserFacingError's own message wins.
      // Everything else keeps the generic copy, so internal text never
      // reaches the user.
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          // Duck-typed, not `instanceof`: importing the class would break
          // every test that mocks the api module without re-exporting it.
          const userFacing = (err as { userFacing?: unknown })?.userFacing;
          const message =
            userFacing && err instanceof Error && err.message
              ? err.message
              : "The server isn't responding. Please try again.";
          set((state) =>
            reducer(state, {
              type: "addToast",
              payload: {
                id: `request-timeout-${Date.now()}`,
                message,
                appearance: "Failure",
                showTimeMs: 5000,
              },
            }),
          );
        });
      }

      if (action.type === "logout") {
        localStorage.removeItem("userName");
      }

      // Zustand merges shallowly: reducer updates Store keys, dispatch is preserved
      set((state) => reducer(state, action as Actions));
    },
  }));

  // Internal state changes, not component-driven actions.
  const apply = (action: Actions) =>
    useZustandStore.setState((state) => reducer(state, action));

  const { dispatch } = useZustandStore.getState();

  apply({ type: "updateConnectionStatus", payload: "connecting" });

  // Escape a stuck loading screen. Cleared on "connected", which navigates
  // explicitly, and on abort so HMR cycles don't leak the timer.
  const loadingEscapeTimer = setTimeout(() => {
    const s = useZustandStore.getState();
    if (s.route === "loading" && !s.room) {
      apply({ type: "navigate", payload: { route: "login" } });
    }
  }, 5000);
  signal.addEventListener("abort", () => clearTimeout(loadingEscapeTimer), { once: true });

  // Room to auto-join after login, from the URL. Cleared after use or when a
  // reconnect forces a manual login.
  const initialParams = new URLSearchParams(location.search);
  let pendingRoomJoin: string | null = initialParams.get("roomName");

  // Captured at disconnect when in a room; a reconnect inside
  // RECONNECT_REJOIN_WINDOW_MS rejoins it silently instead of bouncing to login.
  let lastRoom: { name: string; at: number } | undefined;

  // No stored username means no auto-join, so don't make the user wait on the
  // WS connection before the login form.
  if (pendingRoomJoin && !localStorage.getItem("userName")) {
    apply({ type: "navigate", payload: { route: "login" } });
    pendingRoomJoin = null;
  }

  client.addEventListener("connected", () => {
    apply({ type: "updateConnectionStatus", payload: "connected" });
    // Connected, and this handler routes explicitly below.
    clearTimeout(loadingEscapeTimer);
    dispatch({ type: "setLocale", payload: { language: navigator.language } });

    const userName = localStorage.getItem("userName");
    // Only auto-login from the cache when the user isn't on the login screen;
    // a reconnect landing mid-typing would race their input.
    const currentRoute = useZustandStore.getState().route;
    if (userName && currentRoute !== "login") {
      dispatch({ type: "login", payload: { userName } });
    } else if (!userName) {
      pendingRoomJoin = null; // no stored user, can't auto-join
      dispatch({ type: "navigate", payload: { route: "login" } });
    }
    // userName on the login route: let the user submit their own name.
  }, { signal });

  client.addEventListener("disconnected", () => {
    // Snapshot the room so a fast reconnect can rejoin without bouncing
    // through login. Taken BEFORE the status change, so the reducer hasn't
    // transitioned anything yet.
    //
    // Gated on "connected" because every failed reconnect attempt also fires
    // disconnected. Without the gate each retry re-stamps lastRoom.at, so the
    // window measures time since the last attempt rather than since the drop,
    // and a recovery hours later silently re-creates an expired room as empty.
    const state = useZustandStore.getState();
    if (
      state.connectionStatus === "connected" &&
      state.route === "room" &&
      state.room?.name
    ) {
      lastRoom = { name: state.room.name, at: Date.now() };
    }
    apply({ type: "updateConnectionStatus", payload: "disconnected" });
  }, { signal });

  client.addEventListener("message", (e) => {
    const msg: ClientMessage = (e as MessageEvent<ClientMessage>).data;

    if (msg.type === "loginSuccess" && msg.payload) {
      // Three paths:
      //   1. In-room, inside the reconnect window: silently rejoin, return.
      //   2. Not in-room, ?roomName in the URL: deep-link join, return.
      //   3. Otherwise: fall through to apply() and let the reducer do the
      //      standard transition.
      // 1 and 2 fire WS commands a pure reducer can't; keep them out of it.
      //
      // Guard the username: persisting a missing one stores the string
      // "undefined", which a later load takes for a valid session.
      const loggedInName = msg.payload.userName;
      if (typeof loggedInName === "string" && loggedInName.length > 0) {
        localStorage.setItem("userName", loggedInName);
      }

      const currentRoute = useZustandStore.getState().route;

      if (currentRoute === "room") {
        // Path 1. Calls client.joinOrCreateRoom directly rather than
        // dispatching: the reducer's case would clear room state and flash an
        // empty stack. joinRoomSuccess refreshes the room when it lands.
        if (lastRoom && Date.now() - lastRoom.at < RECONNECT_REJOIN_WINDOW_MS) {
          const roomToRejoin = lastRoom.name;
          lastRoom = undefined;
          apply({ type: "setUser", payload: msg.payload });
          void client.joinOrCreateRoom({ roomName: roomToRejoin }).catch(() => {
            apply({
              type: "addToast",
              payload: {
                id: `reconnect-rejoin-failed-${Date.now()}`,
                message: "Couldn't rejoin the room. Try again.",
                appearance: "Failure",
                showTimeMs: 5000,
              },
            });
          });
          return;
        }
        // Stale or absent: fall through to the reducer. ?roomName stays in the
        // URL so the login form is pre-filled.
      } else if (pendingRoomJoin) {
        // Path 2. joinOrCreateRoom covers the expired/never-existed case
        // server-side, so no client fallback is needed.
        const roomName = pendingRoomJoin;
        pendingRoomJoin = null;
        apply({ type: "setUser", payload: msg.payload });
        dispatch({
          type: "joinOrCreateRoom",
          payload: { roomName },
        });
        return;
      }
    }

    // Apply first so the server's canonical roomName is adopted, then read it
    // back for the URL.
    if (msg.type === "joinRoomSuccess" || msg.type === "createRoomSuccess") {
      apply(msg as Actions);
      const roomName = useZustandStore.getState().room?.name;
      if (roomName) {
        const newUrl = new URL(location.href);
        newUrl.searchParams.set("roomName", roomName);
        history.replaceState(null, document.title, newUrl.href);
      }
      return;
    }

    if (msg.type === "leaveRoomSuccess" || msg.type === "logoutSuccess") {
      // The user left deliberately, so a reconnect must not pull them back.
      lastRoom = undefined;
      apply(msg as Actions);
      const newUrl = new URL(location.href);
      newUrl.searchParams.delete("roomName");
      history.replaceState(null, document.title, newUrl.href);
      return;
    }

    apply(msg as Actions);
  }, { signal });
};
