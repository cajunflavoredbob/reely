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

// Reading window.localStorage THROWS rather than returning null when the
// browser blocks site data (Safari "Block All Cookies", Firefox ETP set to
// block everything). createStore runs before React mounts and there is no
// error boundary above it, so an unguarded read is a blank white page.
// Degrading to "no stored session" just means the user types their name.
const safeStorage = {
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Blocked or full: the session simply won't survive a reload.
    }
  },
  removeItem: (key: string): void => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Blocked: there was nothing persisted to clear in the first place.
    }
  },
};

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
          // Whether entering a room was what failed. The dispatch already put
          // an optimistic room in state, and no server reply is coming to
          // clear it, so the Login CTA would read "joining…" until a reload.
          const wasRoomEntry =
            action.type === "createRoom" ||
            action.type === "joinRoom" ||
            action.type === "joinOrCreateRoom";
          if (wasRoomEntry) {
            // Remember the room the timed-out request was for. The optimistic
            // room is about to go, and the late-reply recovery in the message
            // handler needs a name to put back.
            timedOutRoomEntry = action.payload.roomName;
          }
          set((state) => {
            // Through the reducer's counter, not a clock: several requests can
            // reject in the same millisecond (one close rejects every parked
            // waiter), and duplicate ids collide as React keys.
            const next = reducer(state, { type: "addErrorToast", payload: { message } });
            return wasRoomEntry ? reducer(next, { type: "roomRequestFailed" }) : next;
          });
        });
      }

      if (action.type === "logout") {
        safeStorage.removeItem("userName");
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

  // Room to auto-join after login, from the URL. Cleared after use or when a
  // reconnect forces a manual login.
  const initialParams = new URLSearchParams(location.search);
  let pendingRoomJoin: string | null = initialParams.get("roomName");

  // Captured at disconnect when in a room; a reconnect inside
  // RECONNECT_REJOIN_WINDOW_MS rejoins it silently instead of bouncing to login.
  let lastRoom: { name: string; at: number } | undefined;

  // Room name from a join/create whose reply never arrived in time. A reply
  // timeout is not a dead socket, so the server can still answer: without this
  // the late success finds no room in state, the reducer discards it, and the
  // user sits on the login screen while the server counts them as a member.
  let timedOutRoomEntry: string | undefined;

  // Escape a stuck loading screen. Cleared on "connected", which navigates
  // explicitly, and on abort so HMR cycles don't leak the timer.
  const loadingEscapeTimer = setTimeout(() => {
    const s = useZustandStore.getState();
    if (s.route === "loading" && !s.room) {
      // Control passes to the manual login form, so the URL's room is no
      // longer ours to join: left armed, a later loginSuccess fires a second
      // join for it alongside the one the user submitted, creating a room
      // nobody asked for.
      pendingRoomJoin = null;
      apply({ type: "navigate", payload: { route: "login" } });
    }
  }, 5000);
  signal.addEventListener("abort", () => clearTimeout(loadingEscapeTimer), { once: true });

  // No stored username means no auto-join, so don't make the user wait on the
  // WS connection before the login form.
  if (pendingRoomJoin && !safeStorage.getItem("userName")) {
    apply({ type: "navigate", payload: { route: "login" } });
    pendingRoomJoin = null;
  }

  client.addEventListener("connected", () => {
    apply({ type: "updateConnectionStatus", payload: "connected" });
    dispatch({ type: "setLocale", payload: { language: navigator.language } });

    const userName = safeStorage.getItem("userName");
    // Only auto-login from the cache when the user isn't on the login screen;
    // a reconnect landing mid-typing would race their input.
    const currentRoute = useZustandStore.getState().route;
    if (userName && currentRoute !== "login") {
      dispatch({ type: "login", payload: { userName } });
    } else if (!userName) {
      pendingRoomJoin = null; // no stored user, can't auto-join
      dispatch({ type: "navigate", payload: { route: "login" } });
    } else {
      // userName on the login route: let the user submit their own name. This
      // socket's server-side session is brand new and unauthenticated, so the
      // cached `user` must go with the old one; otherwise Login's submit takes
      // its "already logged in" branch, joins without logging in first, and
      // every attempt comes back NotLoggedInError until the page is reloaded.
      apply({ type: "clearUser" });
      // Same reason the escape timer drops it: the form now owns the room name.
      pendingRoomJoin = null;
    }
    // Cleared last: an early clear plus a throw anywhere above would disarm the
    // escape hatch while still stranding the user on the loading screen.
    clearTimeout(loadingEscapeTimer);
  }, { signal });

  client.addEventListener("disconnected", () => {
    // Snapshot the room so a fast reconnect can rejoin without bouncing
    // through login. Taken BEFORE the status change, so the reducer hasn't
    // transitioned anything yet.
    //
    // Write-once per drop, and gated on "connected" because every failed
    // reconnect attempt also fires disconnected. Re-stamping would make the
    // window measure time since the last attempt rather than since the drop,
    // and a recovery hours later would silently re-create an expired room as
    // empty. The status gate alone is not enough: a socket that completes the
    // handshake and dies before loginSuccess sets the status back to
    // "connected" first. The candidate is held until the drop is actually
    // resolved (a confirmed membership, a deliberate leave, or a window found
    // stale), a rejoin still in flight included, so an unset lastRoom means no
    // drop outstanding.
    const state = useZustandStore.getState();
    if (
      !lastRoom &&
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
        safeStorage.setItem("userName", loggedInName);
      }

      const currentRoute = useZustandStore.getState().route;

      if (currentRoute === "room") {
        // Path 1. Calls client.joinOrCreateRoom directly rather than
        // dispatching: the reducer's case would clear room state and flash an
        // empty stack. joinRoomSuccess refreshes the room when it lands.
        if (lastRoom && Date.now() - lastRoom.at < RECONNECT_REJOIN_WINDOW_MS) {
          const roomToRejoin = lastRoom.name;
          // The candidate is NOT dropped here: it is resolved by the
          // joinRoomSuccess below, not by firing the request. A socket that
          // dies between this dispatch and that reply is still the same
          // outstanding drop, and clearing now would let that second
          // disconnect re-stamp the window at the later time and walk it
          // forward indefinitely.
          apply({ type: "setUser", payload: msg.payload });
          void client.joinOrCreateRoom({ roomName: roomToRejoin }).catch(() => {
            apply({
              type: "addErrorToast",
              payload: { message: "Couldn't rejoin the room. Try again." },
            });
          });
          return;
        }
        // Stale or absent: drop the candidate and fall through to the reducer,
        // which routes to login. Keeping a stale stamp would block the next
        // drop from taking a fresh one. ?roomName stays in the URL so the login
        // form is pre-filled.
        lastRoom = undefined;
      } else if (pendingRoomJoin && currentRoute === "loading") {
        // Path 2. Only from "loading", the boot route: from "login" the user
        // is submitting their own room and Login fires that join itself, and
        // from "config" the server has no providers to build a room from.
        // joinOrCreateRoom covers the expired/never-existed case server-side,
        // so no client fallback is needed.
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
      // A live membership supersedes any rejoin candidate: whatever room this
      // is, it is the one a later drop should be measured against.
      lastRoom = undefined;
      // A reply that beat its own timeout by a hair. The rejection already
      // cleared the optimistic room and the reducer drops a success it has no
      // room for, so put the room back first and let the success fill it in:
      // the server has this user in the room either way.
      if (timedOutRoomEntry && !useZustandStore.getState().room) {
        apply({
          type: "joinOrCreateRoom",
          payload: { roomName: msg.payload.roomName ?? timedOutRoomEntry },
        });
      }
      timedOutRoomEntry = undefined;
      apply(msg as Actions);
      const roomName = useZustandStore.getState().room?.name;
      if (roomName) {
        const newUrl = new URL(location.href);
        newUrl.searchParams.set("roomName", roomName);
        history.replaceState(null, document.title, newUrl.href);
      }
      return;
    }

    // NOT_JOINED belongs here too: the reducer treats it as a completed leave
    // (the server already has us out), so the URL has to be torn down with it
    // or a refresh deep-links straight back into the room just left.
    const leftTheRoom =
      msg.type === "leaveRoomSuccess" ||
      msg.type === "logoutSuccess" ||
      (msg.type === "leaveRoomError" && msg.payload?.errorType === "NOT_JOINED");

    if (leftTheRoom) {
      // The user left deliberately, so neither a reconnect nor a join reply
      // that was still in flight may pull them back.
      lastRoom = undefined;
      timedOutRoomEntry = undefined;
      apply(msg as Actions);
      const newUrl = new URL(location.href);
      newUrl.searchParams.delete("roomName");
      history.replaceState(null, document.title, newUrl.href);
      return;
    }

    apply(msg as Actions);
  }, { signal });
};
