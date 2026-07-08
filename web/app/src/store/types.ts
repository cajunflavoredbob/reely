import type { Toast } from "../components/atoms/Toast";
import type { Routes } from "../types";
import type {
  AppConfig,
  ClientMessage,
  CreateRoomError,
  Filter,
  Filters,
  FilterValue,
  JoinRoomError,
  LoginError,
  Match,
  Media,
  ServerMessage,
  Translations,
  User,
} from "../../../../types/reely";

// Action vocabulary (audit 12 #214 documentation):
//
//   ClientActions ............... actions dispatched FROM the UI (a button
//                                 click, a setLocale, a leaveRoom). Includes
//                                 the local-only `addToast`/`removeToast`/
//                                 `navigate` and the full `ServerMessage`
//                                 union (which the WS layer forwards to the
//                                 server). `Dispatch` -- the function `useDispatch`
//                                 hands out -- only accepts these.
//
//   Actions ..................... the wider union the REDUCER handles. Adds
//                                 the WS-driven server pushes (`ClientMessage`,
//                                 i.e. `loginSuccess`, `match`, ...) plus the
//                                 store's own internal transitions
//                                 (`updateConnectionStatus`, `setUser`) that
//                                 createStore.ts's `apply()` helper drives.
//
// In short: components dispatch ClientActions; the reducer processes Actions.
// `apply()` is internal-only and bridges WS messages + connection state into
// the reducer without exposing them on the public `Dispatch`.
export type ClientActions =
  | { type: "addToast"; payload: Toast }
  | { type: "removeToast"; payload: Toast }
  | { type: "navigate"; payload: { route: Routes } }
  | ServerMessage;

export type Actions =
  | {
    type: "updateConnectionStatus";
    payload: Store["connectionStatus"];
  }
  | { type: "setUser"; payload: User }
  | ClientActions
  | ClientMessage;

export type Dispatch = (action: ClientActions) => void;

export interface Store {
  connectionStatus: "connecting" | "connected" | "disconnected";
  route: Routes;
  error?: LoginError | CreateRoomError | JoinRoomError;
  toasts: Toast[];
  translations?: Translations;
  config?: AppConfig;
  user?: User;
  createRoom?: {
    availableFilters?: Filters;
    filterValues?: Record<string, FilterValue[]>;
  };
  room?: {
    // Canonical (lowercased, allowlist-stripped). Used for URL parameter,
    // share link, Map key on server.
    name: string;
    // Display form (case preserved). Used for UI rendering. Falls back to
    // `name` when undefined (e.g. before the success message lands).
    displayName?: string;
    joined: boolean;
    media?: Media[];
    mediaVersion: number;
    matches?: Match[];
    users?: Array<{ user: User; progress: number }>;
    activeFilters?: Filter[];
  };

  // Per-Store monotonic counters (audit 13 #328, landed 0.4.46). Move
  // toastCounter + mediaVersionCounter from module-scope to state so the
  // reducer is pure and each Store instance keeps its own counters.
  // INVARIANT: never reset within a Store's lifetime -- mediaVersion is
  // used as React's `key` on the CardStack mount; a reset would collide
  // with a prior CardStack and React would reuse the stale one. The
  // pre-#328 module-scope counters had the same invariant; it just
  // lived implicitly in the module.
  toastCounter: number;
  mediaVersionCounter: number;
}
