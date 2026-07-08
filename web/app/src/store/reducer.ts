import type { Toast } from "../components/atoms/Toast";
import type { Actions, Store } from "./types";

// Auto-dismiss delay for error toasts (audit 12 #241). Without an explicit
// showTimeMs the toast persists until the user manually dismisses it,
// which piles up failure messages forever on a flaky connection. The
// connection-failure toast is intentionally NOT given a TTL -- it's
// cleared explicitly when the WS reconnects.
const ERROR_TOAST_MS = 5000;

// crypto.randomUUID() is only defined in secure contexts (https/localhost).
// reely's intended LAN deployment is plain http://192.168.x.x:8000, where
// the call throws TypeError. Use a per-Store counter + random suffix as a
// safe fallback: uniqueness only matters within the React tree, not
// cross-session.
//
// 0.4.46 (audit 13 #328): moved from a module-scope `let` to a counter on
// the Store. The reducer is now pure -- each Store instance keeps its own
// counters. The mintToastId helper is a pure function of the counter.
const mintToastId = (counter: number): string =>
  `toast-${counter}-${Math.random().toString(36).slice(2, 8)}`;

// Shared toast-counter-bump + push-with-Failure-appearance helper.
// Audit 15 #389 consolidated four error cases (filterChangeError,
// leaveRoomError, logoutError, requestFiltersError) that all shared
// the same 9-line return. Returns the two state slices that change
// so each caller can splat them into its return value alongside any
// case-specific state (requestFiltersError also resets
// availableFilters; the helper doesn't touch that).
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

// mediaVersionCounter / toastCounter are fields on Store now (see
// `web/app/src/store/types.ts`). INVARIANT for both: monotonic within
// a Store's lifetime, never reset. mediaVersion is used as React's
// `key` on the CardStack mount; a reset would collide with a prior
// CardStack and React would reuse the stale one. Pre-#328 had the
// same invariant; it just lived implicitly in the module-scope `let`.

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
      // Helper split out of the prior nested ternary, which read as one
      // unbroken array literal and forced the reader to mentally
      // disambiguate which branch handled the disconnected case (audit 9
      // #151). Logic: when disconnected, ensure a "connection-failure"
      // toast exists (idempotent); when connected/connecting, clear it.
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
      // Filter by id, not by object identity. A dispatched payload that
      // isn't reference-equal to the stored toast (e.g. a fresh object
      // built from { id, message, ... }) would otherwise silently no-op
      // the removal.
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
          // Initial load: go to login screen.
          // Reconnect while in a room: the server session is gone, so clear room
          // state and send the user back to login to re-join.
          // Reconnect from login/config: no navigation needed.
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
            // Prefer the server's sanitized canonical name when provided so
            // local state (and the URL bar) match what the server stores.
            // Pre-0.2.10 servers don't send roomName; fall back to the
            // pre-dispatch name in that case.
            name: action.payload.roomName ?? state.room.name,
            // Display form for UI. Pre-0.2.19 servers omit this; fall back
            // to the canonical name so the UI still has something to show.
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
      // toastCounter only bumps on the isOtherUser branch -- the self-apply
      // case doesn't surface a toast (no need to announce your own action).
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
    // Filter-apply failures (cooldown throttle, no media for the filter set)
    // had no case and fell through silently -- the FilterPanel closes on
    // send, so the apply just appeared to do nothing. Surface the server's
    // message as a toast.
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
    // leaveRoomError / logoutError previously had no case and fell through,
    // so a failed leave/logout gave the user no feedback at all. Surface a
    // toast. Both are edge cases (NOT_JOINED / NotLoggedIn).
    case "leaveRoomError":
      // NOT_JOINED means the server already considers us out of any room
      // (audit 16 #452): treat it as a successful leave instead of only
      // toasting. Before this, a failed silent rejoin left the user on a
      // room screen with no server-side membership -- swipes were
      // silently dropped and Leave dead-ended on this very error, a hard
      // trap only a page refresh escaped.
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
      // The FilterPanel shows "Loading filters..." until availableFilters is
      // set. The server failed to fetch them, so set an empty filter set to
      // drop the spinner and raise a toast -- otherwise the panel hangs forever.
      return {
        ...state,
        ...addErrorToast(state, "Couldn't load filters"),
        createRoom: {
          ...state.createRoom,
          availableFilters: { filters: [], filterTypes: {} },
        },
      };
    case "requestFilterValuesError":
      // Mark the key as resolved-with-no-values so the FilterPanel can drop
      // its "Loading..." state and fall back to the free-text SearchControl.
      // The error is already logged server-side; the user just sees the
      // filter row become editable instead of stuck loading.
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
    // Room events only fire to clients joined to a room, so the server
    // contract guarantees state.room is set when these arrive. Even so,
    // the cases guard with `if (!state.room) return state;` rather than
    // spread `state.room!` -- a runtime invariant violation now becomes a
    // safe no-op instead of a thrown TypeError (audit 9 #120).
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
      // Idempotent on userName: a reconnecting/rejoining user broadcasts
      // userJoinedRoom again, and a blind append would show that user twice
      // in everyone else's list. Drop any existing entry first.
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
    // The ServerMessage variants are dispatched by the UI and forwarded
    // to the WS client by createStore's dispatch wrapper. The reducer
    // doesn't react to them locally -- it waits for the server's reply
    // (the matching *Success / *Error / *Applied ClientMessage) which
    // IS handled above. Enumerating them as no-ops here lets the
    // `never` check below catch any future variant that gets added to
    // the Actions union without a deliberate decision (audit 13 #305).
    case "rate": {
      // Forwarded to the WS client like the other ServerMessage variants
      // below, but ALSO pruned from room.media locally (audit 16 #430).
      // The mounted CardStack ignores prop changes (memo () => true), so
      // this doesn't disturb the live deck -- but a desktop/mobile layout
      // flip across the 900px breakpoint remounts CardStack, and its
      // initializer re-slices room.media. Without the prune, every card
      // swiped since the last join/filter-apply resurrected into the deck
      // as dead swipes (the server silently drops re-rates). Mirrors the
      // server's getMediaForUser filtering on the rejoin path.
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
      // Exhaustive-check via `never`. A new variant added to the
      // Actions union without a case (or no-op above) errors at
      // typecheck. The `void _exhaustive` swallows the value so the
      // linter doesn't flag it as unused.
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
};
