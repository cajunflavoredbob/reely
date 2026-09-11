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

// ClientActions: what the UI dispatches. The local-only toast/navigate
// variants plus the whole ServerMessage union the WS layer forwards.
// `Dispatch` accepts only these.
//
// Actions: the wider union the reducer handles, adding server pushes
// (ClientMessage) and internal transitions. createStore's `apply()` drives
// those without exposing them on the public `Dispatch`.
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
  // Drops the cached identity when the server-side session behind it is gone,
  // so the Login screen logs in again instead of joining as a stale user.
  | { type: "clearUser" }
  // A join/create request that never got a reply. Clears the optimistic room
  // the dispatch put in place so the CTA stops reading as "joining…".
  | { type: "roomRequestFailed" }
  // Failure toast minted through the store's own counter. Lets createStore
  // raise one without hand-rolling an id.
  | { type: "addErrorToast"; payload: { message: string } }
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
    // Canonical (lowercased, allowlist-stripped): URL param, share link,
    // server Map key.
    name: string;
    // Display form (case preserved); falls back to `name` when undefined.
    displayName?: string;
    joined: boolean;
    media?: Media[];
    mediaVersion: number;
    matches?: Match[];
    users?: Array<{ user: User; progress: number }>;
    activeFilters?: Filter[];
  };

  // Per-Store counters, on state rather than module scope so the reducer stays
  // pure. INVARIANT: never reset within a Store's lifetime. mediaVersion is
  // React's `key` on the CardStack mount, so a reset collides with a prior
  // stack and React reuses it.
  toastCounter: number;
  mediaVersionCounter: number;
}
