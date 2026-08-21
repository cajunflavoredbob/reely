import type { Toast } from "../components/atoms/Toast";
import type { Actions, Store } from "./types";

// Auto-dismiss delay for error toasts; without it failure messages pile up
// forever on a flaky connection. The connection-failure toast is exempt: it
// clears when the WS reconnects.
const ERROR_TOAST_MS = 5000;

// crypto.randomUUID() throws outside secure contexts, and reely deploys on
// plain http over a LAN. A per-Store counter plus a random suffix suffices:
// uniqueness only has to hold within the React tree.
const mintToastId = (counter: number): string =>
  `toast-${counter}-${Math.random().toString(36).slice(2, 8)}`;

// Bumps the toast counter and pushes a Failure toast. Returns only the two
// changed slices so callers can splat in their own case-specific state.
const addErrorToast = (state: Store, message: string): Pick<Store, "toastCounter" | "toasts"> => {
  const toastCounter = state.toastCounter + 1;
  return {
    toastCounter,
    toasts: [
      ...state.toasts,
      { id: mintToastId(toastCounter), message, appearance: "Failure", showTimeMs: ERROR_TOAST_MS },
    ],
  };
};

// INVARIANT for mediaVersionCounter and toastCounter: monotonic within a
// Store's lifetime, never reset. mediaVersion is React's `key` on the
// CardStack mount, so a reset collides with a prior stack and React reuses it.

export const initialState: Store = {
  connectionStatus: "disconnected",
  route: "loading",
  toasts: [],
  toastCounter: 0,
  mediaVersionCounter: 0,
};

export const reducer = (state: Store = initialState, action: Actions): Store => {
  switch (action.type) {
    case "updateConnectionStatus": {
      // Idempotently add a connection-failure toast when disconnected; clear
      // it otherwise.
      const updateConnectionToasts = (toasts: Toast[]): Toast[] => {
        if (action.payload === "disconnected") {
          const alreadyShown = toasts.some((t) => t.id === "connection-failure");
          return alreadyShown
            ? toasts
            : [
              { id: "connection-failure", message: "Disconnected", appearance: "Failure" },
              ...toasts,
            ];
        }
        return toasts.filter((t) => t.id !== "connection-failure");
      };
      return {
        ...state,
        connectionStatus: action.payload,
        toasts: updateConnectionToasts(state.toasts),
      };
    }
    case "config": {
      if (action.payload.requiresConfiguration) {
        return { ...state, config: action.payload, route: "config" };
      }
      return { ...state, config: action.payload };
    }
    case "navigate":
      return {
        ...state,
        route: action.payload.route,
      };
    case "addToast":
      return { ...state, toasts: [...state.toasts, action.payload] };
    case "removeToast":
      // By id, not object identity: a rebuilt payload isn't reference-equal
      // and the removal would silently no-op.
      return {
        ...state,
        toasts: state.toasts.filter((toast) => toast.id !== action.payload.id),
      };
    case "setUser":
      return { ...state, user: action.payload };
    case "loginSuccess": {
      if (action.payload) {
        return {
          ...state,
          user: action.payload,
          // An in-room reconnect means the server session is gone, so clear
          // the room and go back to login. From login/config, stay put.
          ...(state.route === "loading"
            ? { route: "login" }
            : state.route === "room"
            ? { route: "login", room: undefined }
            : {}),
        };
      }
      // Defensive guard: payload is always present per protocol
      return state;
    }
    case "createRoom":
    case "joinRoom":
    case "joinOrCreateRoom": {
      const mv = state.mediaVersionCounter + 1;
      return {
        ...state,
        mediaVersionCounter: mv,
        error: undefined,
        room: { name: action.payload.roomName, joined: false, mediaVersion: mv },
      };
    }
    case "createRoomSuccess":
    case "joinRoomSuccess": {
      if (state.room) {
        const mv = state.mediaVersionCounter + 1;
        return {
          ...state,
          mediaVersionCounter: mv,
          route: "room",
          error: undefined,
          room: {
            ...state.room,
            // Prefer the server's canonical name so local state and the URL
            // match what it stores. Older servers omit it.
            name: action.payload.roomName ?? state.room.name,
            // Display form; older servers omit it.
            displayName: action.payload.displayName ?? state.room.displayName,
            joined: true,
            matches: action.payload.previousMatches,
            media: action.payload.media,
            mediaVersion: mv,
            users: action.payload.users,
            activeFilters: action.payload.filters ?? [],
          },
        };
      }
      // Defensive guard: room is always set before a success response per protocol
      return state;
    }
    case "filterChangeApplied": {
      if (!state.room) return state;
      const { appliedBy, media, filters } = action.payload;
      const isOtherUser = !!appliedBy && appliedBy !== state.user?.userName;
      const mv = state.mediaVersionCounter + 1;
      // No toast for your own apply, so the counter only bumps for others.
      let toasts = state.toasts;
      let toastCounter = state.toastCounter;
      if (isOtherUser) {
        const availableFilters = state.createRoom?.availableFilters?.filters;
        const titles = filters.map((f) => {
          const def = availableFilters?.find((d) => d.key === f.key);
          return def?.title ?? f.key;
        });
        const message = titles.length > 0
          ? `${appliedBy} applied filters: ${titles.join(", ")}`
          : `${appliedBy} cleared all filters`;
        toastCounter = state.toastCounter + 1;
        toasts = [
          ...toasts,
          { id: mintToastId(toastCounter), message, showTimeMs: 5000 },
        ];
      }
      return {
        ...state,
        toasts,
        toastCounter,
        mediaVersionCounter: mv,
        room: {
          ...state.room,
          media,
          mediaVersion: mv,
          activeFilters: filters,
        },
      };
    }
    // The FilterPanel closes on send, so a silent failure looks like nothing
    // happened. Surface the server's message.
    case "filterChangeError":
      return { ...state, ...addErrorToast(state, action.payload.message) };
    case "logoutSuccess":
      return { ...state, user: undefined, room: undefined, route: "login" };
    case "loginError":
    case "joinRoomError":
    case "createRoomError":
      return { ...state, error: action.payload, route: "login", room: undefined };
    case "leaveRoomSuccess":
      return { ...state, room: undefined, route: "login" };
    case "leaveRoomError":
      // NOT_JOINED means the server already has us out, so treat it as a
      // successful leave. Toasting alone traps the user on a room screen with
      // no membership: swipes drop and Leave dead-ends on this same error.
      if (action.payload?.errorType === "NOT_JOINED") {
        return { ...state, room: undefined, route: "login" };
      }
      return { ...state, ...addErrorToast(state, "Couldn't leave the room.") };
    case "logoutError":
      return { ...state, ...addErrorToast(state, "Couldn't log out.") };
    case "translations":
      return { ...state, translations: action.payload };
    case "requestFiltersSuccess":
      return {
        ...state,
        createRoom: { ...state.createRoom, availableFilters: action.payload },
      };
    case "requestFilterValuesSuccess":
      return {
        ...state,
        createRoom: {
          ...state.createRoom,
          filterValues: {
            ...state.createRoom?.filterValues,
            [action.payload.request.key]: action.payload.values,
          },
        },
      };
    case "requestFiltersError":
      // The panel spins until availableFilters is set, so an empty set is what
      // stops it hanging forever.
      return {
        ...state,
        ...addErrorToast(state, "Couldn't load filters"),
        createRoom: {
          ...state.createRoom,
          availableFilters: { filters: [], filterTypes: {} },
        },
      };
    case "requestFilterValuesError":
      // Resolved-with-no-values, so the panel drops its loading state and
      // falls back to the free-text SearchControl.
      return {
        ...state,
        createRoom: {
          ...state.createRoom,
          filterValues: {
            ...state.createRoom?.filterValues,
            [action.payload.key]: [],
          },
        },
      };
    // The server contract guarantees state.room here, but the cases guard
    // anyway so a violated invariant no-ops instead of throwing.
    case "match":
      if (!state.room) return state;
      return {
        ...state,
        room: {
          ...state.room,
          matches: [
            ...(state.room.matches ?? []).filter(
              (_) => _.media.id !== action.payload.media.id,
            ),
            action.payload,
          ],
        },
      };
    case "userJoinedRoom":
      // Idempotent on userName: a rejoining user broadcasts again, and a blind
      // append would list them twice.
      if (!state.room) return state;
      return {
        ...state,
        room: {
          ...state.room,
          users: [
            ...(state.room.users ?? []).filter(
              ({ user }) => user.userName !== action.payload.user.userName,
            ),
            action.payload,
          ],
        },
      };
    case "userLeftRoom":
      if (!state.room) return state;
      return {
        ...state,
        room: {
          ...state.room,
          users: (state.room.users ?? []).filter(
            ({ user }) => user.userName !== action.payload.userName,
          ),
        },
      };
    case "userProgress":
      if (!state.room) return state;
      return {
        ...state,
        room: {
          ...state.room,
          users: (state.room.users ?? []).map((userProgress) =>
            userProgress.user.userName === action.payload.user.userName
              ? { ...userProgress, progress: action.payload.progress }
              : userProgress
          ),
        },
      };
    // ServerMessage variants go to the WS client; the reducer waits for the
    // server's reply instead. Listed as explicit no-ops so the `never` check
    // below catches any new variant.
    case "rate": {
      // Also pruned from room.media locally. The mounted CardStack ignores
      // prop changes, but a layout flip across the breakpoint remounts it and
      // re-slices room.media; without the prune every card swiped since the
      // last join resurrects into the deck as a dead swipe.
      // mediaVersion deliberately NOT bumped: no remount is wanted here.
      if (!state.room?.media) return state;
      return {
        ...state,
        room: {
          ...state.room,
          media: state.room.media.filter((m) => m.id !== action.payload.mediaId),
        },
      };
    }
    case "login":
    case "logout":
    case "leaveRoom":
    case "setLocale":
    case "requestFilters":
    case "requestFilterValues":
    case "applyFilters":
      return state;
    default: {
      // Exhaustive check: an uncased Actions variant errors at typecheck.
      // `void` keeps the linter from flagging the unused binding.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
};
