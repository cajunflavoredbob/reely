import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { ReelyClient } from "../api/reely";
import type { ClientMessage } from "../../../../types/reely";
import { reducer, initialState } from "./reducer";
import type { Actions, ClientActions, Dispatch, Store } from "./types";

// Exhaustive ClientActions -> ReelyClient method dispatch. ClientActions
// is `ServerMessage | { type: "addToast" | "removeToast" | "navigate"; ... }`
// -- the UI-only variants don't have a corresponding ReelyClient method,
// so they return undefined and the caller skips them.
//
// Audit 13 #285: previously this lived alongside a parallel
// `SERVER_MESSAGE_TYPES` Set used as a runtime guard. The Set + the
// switch covered the same types and had to stay in sync, so adding a
// new ServerMessage required two updates. Folded the runtime guard
// into the switch's no-op cases; the `default: never` still enforces
// exhaustiveness at compile time, so a new ClientAction variant added
// without a case here now errors at typecheck instead of silently
// being dispatched to the WS client.
//
// The original allowlist (audit 9 #159) guarded against bugs like
// `if (action.type in client)` matching inherited EventTarget methods.
// The switch covers the same surface explicitly without inheritance.
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
    // UI-only actions: not server-bound, return undefined so the caller
    // skips the Promise.catch attach.
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

// How long after a WS disconnect a reconnect will silently auto-rejoin the
// last room instead of dumping the user back to the login screen. A network
// blip or server restart is a transient event; a long absence (closed laptop
// overnight, switched WiFi an hour later) should require explicit re-entry.
const RECONNECT_REJOIN_WINDOW_MS = 10 * 60 * 1000;

// Singleton client; useZustandStore is populated by createStore()
let client: ReelyClient;
export let useZustandStore: UseBoundStore<StoreApi<ZustandStore>>;

// AbortController for the listeners createStore registers below
// (audit 13 #302 / audit 14 #365). Previously the listeners were never
// removed; a second createStore call (HMR, repeated init) would
// double-bind. Now a re-call aborts the prior signal first, tearing
// down every listener in one operation. We track the controller at
// module scope so the next call can abort the previous one.
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
      // ServerMessage variants forward to a ReelyClient method;
      // ClientAction-only variants (addToast / removeToast / navigate)
      // return undefined from the dispatch and skip the catch attach.
      const result: unknown = dispatchToClient(client, action);
      // Request methods (login / joinRoom / leaveRoom / createRoom /
      // joinOrCreateRoom / requestFilters / requestFilterValues) reject
      // if the server reply times out (REQUEST_TIMEOUT_MS in
      // api/reely.ts). Surface that as a toast rather than leaving an
      // unhandled rejection and a UI stuck waiting on a reply that
      // will never arrive.
      //
      // `rate` and `setLocale` resolve once the WS frame is sent and swallow
      // their own failures, so this catch stays a no-op for them (audit 12
      // #246). `applyFilters` is no longer in that group: it rejects both on
      // its connect timeout and when the user changed rooms while it was
      // parked, and the second case is not a server problem at all. Prefer the
      // thrown message when there is one, so the toast describes what actually
      // happened instead of blaming the server for it. Only errors explicitly
      // tagged UserFacingError are shown verbatim; everything else keeps the
      // generic copy rather than risking internal text in front of the user.
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          // Duck-typed rather than `instanceof UserFacingError`: importing the
          // class here would make every test that mocks the api module fail
          // unless it also re-exported it, which is a trap rather than a
          // safeguard. A truthy `userFacing` flag is enough.
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

  // apply is used for internal state changes that aren't component-driven actions
  const apply = (action: Actions) =>
    useZustandStore.setState((state) => reducer(state, action));

  const { dispatch } = useZustandStore.getState();

  apply({ type: "updateConnectionStatus", payload: "connecting" });

  // Safety-net: if we're still on the loading screen 5 seconds after page
  // load and no room join is in progress, escape to the login screen.
  // The timer is captured + cleared on a successful "connected" event
  // (audit 13 #303): once we've connected, the loading-screen escape
  // is moot because the connected handler navigates explicitly. The
  // prior unconditional setTimeout still fired (as a no-op via the
  // route check) on every page load even after the user had joined.
  // signal.addEventListener("abort", ...) wires the timer into the
  // listenerController teardown so HMR cycles don't leak.
  const loadingEscapeTimer = setTimeout(() => {
    const s = useZustandStore.getState();
    if (s.route === "loading" && !s.room) {
      apply({ type: "navigate", payload: { route: "login" } });
    }
  }, 5000);
  signal.addEventListener("abort", () => clearTimeout(loadingEscapeTimer), { once: true });

  // Room to auto-join after login, populated from the URL on initial page load.
  // Cleared after use or when a server-restart reconnect forces the user to login manually.
  const initialParams = new URLSearchParams(location.search);
  let pendingRoomJoin: string | null = initialParams.get("roomName");

  // Captured at WS disconnect when the user is in a room: if the reconnect
  // happens inside RECONNECT_REJOIN_WINDOW_MS, the room is silently rejoined
  // instead of bouncing the user to login. Cleared after a successful auto-
  // rejoin, on explicit leave/logout, or when stale.
  let lastRoom: { name: string; at: number } | undefined;

  // If there's a room in the URL but no cached session, skip the loading screen
  // immediately -- the user can't auto-join without a stored username, so there's
  // no reason to wait for the WS connection before showing the login form.
  if (pendingRoomJoin && !localStorage.getItem("userName")) {
    apply({ type: "navigate", payload: { route: "login" } });
    pendingRoomJoin = null;
  }

  client.addEventListener("connected", () => {
    apply({ type: "updateConnectionStatus", payload: "connected" });
    // Clear the 5s loading-escape timer: we're connected, the connected
    // handler routes the user explicitly below. No need for the escape.
    clearTimeout(loadingEscapeTimer);
    // setLocale is a ServerMessage so dispatch forwards it to the WS client
    dispatch({ type: "setLocale", payload: { language: navigator.language } });

    const userName = localStorage.getItem("userName");
    // Stale-localStorage race guard (audit 13 #301): only auto-dispatch
    // the cached-username login when the user isn't actively on the
    // login screen. The prior code dispatched unconditionally; on a
    // reconnect that happened to land mid-typing on Login, the cached
    // stale userName would race the user's fresh input. We always
    // assume an explicit Login route means the user is choosing their
    // identity manually -- don't preempt with a stored value.
    const currentRoute = useZustandStore.getState().route;
    if (userName && currentRoute !== "login") {
      dispatch({ type: "login", payload: { userName } });
    } else if (!userName) {
      pendingRoomJoin = null; // no stored user, can't auto-join
      dispatch({ type: "navigate", payload: { route: "login" } });
    }
    // userName && route === "login": skip the auto-login; the user's
    // active session will submit their chosen name explicitly.
  }, { signal });

  client.addEventListener("disconnected", () => {
    // Snapshot the room (if any) so a fast reconnect can rejoin without
    // bouncing through the login screen. Captured BEFORE the connection
    // status changes so the reducer can't have transitioned anything yet.
    //
    // Gated on connectionStatus === "connected" (audit 16 #428): handleClose
    // fires a disconnected event for EVERY socket close, including each
    // failed reconnect attempt during an outage. Route and room stay set the
    // whole time, so without the gate every retry re-stamped lastRoom.at and
    // the rejoin window measured time since the last ATTEMPT, not since the
    // drop -- it could never expire while the tab kept retrying, and a
    // recovery hours later silently re-created the (by then TTL-expired)
    // room as empty. Only a live connection's drop starts the clock.
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
      // ── loginSuccess handler -- consolidated entry point ──────────────
      // Three paths through this block (audit 13 #304):
      //   1. In-room + within reconnect window: silently rejoin (side
      //      effect, reducer-incompatible). RETURNS early.
      //   2. Not-in-room + URL has ?roomName: deep-link auto-join (side
      //      effect, reducer-incompatible). RETURNS early.
      //   3. Anything else (in-room stale, no pendingRoomJoin, etc.):
      //      FALL THROUGH to `apply(msg as Actions)` at the bottom of the
      //      handler; the reducer's loginSuccess case does the standard
      //      transition (setUser, navigate to login).
      // The split exists because paths 1+2 need to fire WS commands
      // (joinOrCreateRoom) that a pure reducer can't do. Don't move them
      // into the reducer; the side-effect boundary is deliberate.
      //
      // Only persist a real username. The old `userName!` assertion would
      // store the literal string "undefined" if the field were ever missing,
      // and a later load would treat that truthy string as a valid session
      // and auto-"log in" as user "undefined".
      const loggedInName = msg.payload.userName;
      if (typeof loggedInName === "string" && loggedInName.length > 0) {
        localStorage.setItem("userName", loggedInName);
      }

      const currentRoute = useZustandStore.getState().route;

      if (currentRoute === "room") {
        // Path 1: WS reconnect while the user is in a room. If it was a
        // quick blip (within RECONNECT_REJOIN_WINDOW_MS of disconnect)
        // silently rejoin the same room. Calling client.joinOrCreateRoom
        // directly (instead of dispatching the action) avoids the
        // reducer's joinOrCreateRoom case which would clear room state
        // and flash an empty stack; the server's joinRoomSuccess will
        // refresh the room when it arrives. Past the window: drop to
        // Path 3 (the reducer kicks back to login).
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
        // Stale window or no lastRoom: fall through so the reducer's
        // loginSuccess case clears room and navigates to login. Keep
        // ?roomName in the URL so the form stays pre-filled.
      } else if (pendingRoomJoin) {
        // Stored session + URL roomName: skip login screen and join directly.
        // joinOrCreateRoom handles the "room expired/never existed" case on
        // the server, so no client-side fallback is needed.
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

    // For room events, apply the message first (which adopts the server's
    // canonical roomName when present), then read post-update state for the URL.
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
      // Explicit leave/logout drops any auto-rejoin candidate: the user
      // deliberately left, so a subsequent reconnect should NOT silently
      // pull them back into the room.
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
