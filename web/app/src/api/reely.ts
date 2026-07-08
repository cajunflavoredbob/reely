import type {
  ClientMessage,
  CreateRoomRequest,
  Filter,
  FilterValueRequest,
  JoinRoomRequest,
  Locale,
  Login,
  Rate,
  ServerMessage,
} from "../../../../types/reely";

const API_URL = (() => {
  const url = new URL(location.href);
  url.pathname = `${document.body.dataset.rootPath ?? ""}/api/ws`;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.search = ""; // don't carry over page query params into the WS URL
  return url.href;
})();

type FilterClientMessageByType<
  A extends ClientMessage,
  ClientMessageType extends string,
> = A extends { type: ClientMessageType } ? A : never;

// A connection must stay open this long before it counts as "healthy" and
// resets the reconnect backoff. Shorter than this and a server that accepts
// the handshake then immediately closes (crash loop) would reconnect at the
// base delay forever -- the backoff would never escalate.
const STABLE_CONNECTION_MS = 10_000;

// How long a request (login, joinRoom, ...) waits for its server reply before
// giving up. Without it a dropped reply hangs the request promise -- and the
// UI -- permanently.
const REQUEST_TIMEOUT_MS = 15_000;

export class ReelyClient extends EventTarget {
  ws!: WebSocket;
  reconnectionAttempts = 0;
  private stableConnectionTimer?: ReturnType<typeof setTimeout>;
  // `rate` messages dropped while the socket was down (the brief gap between
  // the socket closing and the UI noticing). Flushed on the next open so a
  // swipe in that window still reaches the server. Bounded so a long outage
  // can't grow it without limit.
  //
  // Each entry carries the room the swipe was made in (audit 16 #429) so
  // the flush can never replay it into a DIFFERENT room: all rooms draw
  // from the same library, so the server-side media.has() guard would
  // accept a cross-room flush as a legitimate vote (and on a shared
  // device, attribute it to whoever joined next). Entries without a tag
  // (queued before any join completed) flush unconditionally, matching
  // the pre-#429 behavior.
  private pendingRates: Array<{ msg: ServerMessage; roomName?: string }> = [];

  // Canonical name of the room this client most recently joined/created;
  // tags queued rates (above) and is cleared on leave/logout. (audit 16 #429)
  private currentRoomName?: string;

  // The handler currently waiting to flush pendingRates after the next
  // post-reconnect joinRoomSuccess / createRoomSuccess (added 0.4.2 #86).
  // Kept on the instance so each reconnect cycle replaces the previous one
  // rather than accumulating: a user who reconnects repeatedly without
  // rejoining (server-restart loop on login, or logged out) would otherwise
  // grow the EventTarget listener list unboundedly across the page session
  // (audit 11 #175 / audit 12 #213).
  private flushAfterRejoinHandler?: EventListener;

  constructor() {
    super();
    // Rate-queue room-affinity bookkeeping (audit 16 #429): remember which
    // room the user is in (for tagging queued rates), and drop all queued
    // rate state when the room session explicitly ends -- an offline swipe
    // from a left room must not flush into the next room joined, and on a
    // shared device must not be attributed to the next user after logout.
    this.addEventListener("joinRoomSuccess", this.captureRoomName);
    this.addEventListener("createRoomSuccess", this.captureRoomName);
    this.addEventListener("leaveRoomSuccess", this.clearRateState);
    this.addEventListener("logoutSuccess", this.clearRateState);
    this.connect();
  }

  private captureRoomName = (e: Event) => {
    if (!(e instanceof MessageEvent)) return;
    const data = (e as MessageEvent<ClientMessage>).data;
    if (data.type === "joinRoomSuccess" || data.type === "createRoomSuccess") {
      this.currentRoomName = data.payload.roomName;
    }
  };

  private clearRateState = () => {
    this.pendingRates = [];
    this.sentRateIds.clear();
    this.currentRoomName = undefined;
  };

  private connect() {
    if (this.ws) {
      this.ws.removeEventListener("message", this.handleMessage);
      this.ws.removeEventListener("open", this.handleOpen);
      this.ws.removeEventListener("close", this.handleClose);
      this.ws.removeEventListener("error", this.handleError);
    }

    this.ws = new WebSocket(API_URL);
    this.ws.addEventListener("message", this.handleMessage);
    this.ws.addEventListener("close", this.handleClose, { once: true });
    this.ws.addEventListener("open", this.handleOpen, { once: true });
    this.ws.addEventListener("error", this.handleError);
  }

  private handleMessage = (e: MessageEvent<string>) => {
    try {
      // Shape-guard before treating the parsed value as a ClientMessage
      // (audit 13 #311). The prior code parsed + cast, then accessed
      // `msg.type` -- which TypeErrors on non-object JSON literals (null,
      // numbers, strings) and silently no-ops on object literals without
      // a `type` field. Falling through to the catch worked by accident;
      // surface the bad-frame case explicitly so a buggy server can't
      // ship something the dispatcher would mis-handle.
      const parsed: unknown = JSON.parse(e.data);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof (parsed as { type?: unknown }).type !== "string"
      ) {
        console.warn("reely WS: dropping frame with unexpected shape", parsed);
        return;
      }
      const msg = parsed as ClientMessage;
      this.dispatchEvent(new MessageEvent(msg.type, { data: msg }));
      this.dispatchEvent(new MessageEvent("message", { data: msg }));
    } catch (err) {
      console.error(err);
    }
  };

  waitForConnected = () => {
    if (this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve(true);
    }

    // Wait on the client's own "connected" event, not the current socket's
    // "open". If waitForConnected is called while the socket is CLOSING/CLOSED
    // (the gap between handleClose and the scheduled reconnect), connect()
    // swaps in a brand-new socket -- an "open" listener bound to the dead one
    // would never fire. "connected" is dispatched by handleOpen regardless of
    // which underlying socket opened, so it survives reconnects.
    return new Promise((resolve) => {
      this.addEventListener("connected", () => resolve(true), { once: true });
    });
  };

  private handleOpen = () => {
    // Do NOT flush the queued `rate` messages here -- the new socket hasn't
    // logged in or rejoined a room yet, so the server's handleRate would
    // drop every one (no userName, no room.users membership). Wait for the
    // next join-success on this socket (the reducer's auto-rejoin path
    // calls joinOrCreateRoom on reconnect, audit 4 #17 / 0.3.19) and flush
    // then. If no join happens after the reconnect (user explicitly left
    // before disconnect), the queue stays put -- it'll get drained the
    // next time the user joins, OR aged out by the MAX_PENDING_RATES cap.
    //
    // Tear down any prior reconnect's pending listener BEFORE registering
    // this one (audit 11 #175 / audit 12 #213). Without this, every WS open
    // that didn't see a join-success leaks two listeners.
    if (this.flushAfterRejoinHandler) {
      this.removeEventListener("joinRoomSuccess", this.flushAfterRejoinHandler);
      this.removeEventListener("createRoomSuccess", this.flushAfterRejoinHandler);
    }
    const flushAfterRejoin = (e: Event) => {
      if (!(e instanceof MessageEvent)) return;
      this.removeEventListener("joinRoomSuccess", flushAfterRejoin);
      this.removeEventListener("createRoomSuccess", flushAfterRejoin);
      this.flushAfterRejoinHandler = undefined;
      const data = (e as MessageEvent<ClientMessage>).data;
      const joinedRoom =
        data.type === "joinRoomSuccess" || data.type === "createRoomSuccess"
          ? data.payload.roomName
          : undefined;
      const queued = this.pendingRates;
      this.pendingRates = [];
      // Re-queue any message we can't send (audit 13 #286). The prior
      // loop silently dropped the tail if the socket closed mid-flush:
      // a `break` on `readyState !== OPEN` would lose every message
      // after the first failed send, and the user's swipes during that
      // brief disconnection window would simply not register. Now any
      // unsent messages survive into the next reconnect's flush by
      // landing back on pendingRates. The order is preserved (we
      // unshift the surviving tail back to the head) so swipe order
      // doesn't get shuffled across reconnects.
      const remaining: typeof queued = [];
      for (const entry of queued) {
        // Room affinity (audit 16 #429): a rate queued in room A must not
        // flush into room B. Untagged entries (queued before any join
        // completed) flush unconditionally, as before.
        if (entry.roomName !== undefined && entry.roomName !== joinedRoom) {
          console.warn(
            `Dropped queued "rate" from room "${entry.roomName}" (rejoined "${joinedRoom}")`,
          );
          continue;
        }
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(entry.msg));
        } else {
          remaining.push(entry);
        }
      }
      if (remaining.length) {
        this.pendingRates.unshift(...remaining);
      }
    };
    this.flushAfterRejoinHandler = flushAfterRejoin;
    this.addEventListener("joinRoomSuccess", flushAfterRejoin);
    this.addEventListener("createRoomSuccess", flushAfterRejoin);

    this.dispatchEvent(new Event("connected"));
    // Reset the backoff counter only after the connection proves stable.
    // Resetting on every `open` let an accept-then-close crash loop reconnect
    // at the base delay indefinitely -- the thundering herd the backoff is
    // meant to prevent.
    clearTimeout(this.stableConnectionTimer);
    this.stableConnectionTimer = setTimeout(() => {
      this.reconnectionAttempts = 0;
    }, STABLE_CONNECTION_MS);
  };

  // Socket errors were previously swallowed entirely. Reconnection is driven
  // by the close handler; this just makes the error visible.
  private handleError = (event: Event) => {
    console.warn("reely WebSocket error", event);
  };

  private handleClose = () => {
    // The connection didn't survive to "stable"; keep the backoff counter so
    // a crash loop escalates the delay.
    clearTimeout(this.stableConnectionTimer);
    this.dispatchEvent(new Event("disconnected"));

    // Capped exponential backoff with jitter. Base 500ms, doubling per attempt
    // up to a 30s ceiling, plus up to 1s of random jitter. The old schedule
    // (attempts * 1000, starting at 0) reconnected instantly then grew
    // linearly and uncapped -- it hammered a down server and made every
    // client retry in lockstep (thundering herd) after a restart.
    const base = Math.min(30_000, 500 * 2 ** this.reconnectionAttempts);
    const delay = base + Math.random() * 1_000;
    setTimeout(() => this.connect(), delay);

    this.reconnectionAttempts += 1;
  };

  // Wait for any one of several message types, with shared cleanup. A naive
  // Promise.race of per-type {once:true} listeners would leak the unfired
  // listener forever, which accumulates across reconnect cycles and can fire
  // on later unrelated messages with the same type.
  //
  // Rejects after REQUEST_TIMEOUT_MS so a dropped server reply (handler crash,
  // lost message) surfaces as an error instead of hanging the caller -- and
  // the UI -- forever. The cleanup runs on the timeout path too, so no
  // listener leaks.
  //
  // `match` correlates a response to a specific request. Without it the first
  // message of a matching TYPE resolves the promise -- fine when one request
  // of that type is in flight, but for overlapping requestFilterValues calls
  // (FilterPanel fires one per filter key) the wrong key's response could
  // resolve the wrong waiter. A non-matching message is ignored; the waiter
  // keeps listening (and is still bounded by the timeout).
  waitForAnyMessage = <K extends ClientMessage["type"]>(
    types: K[],
    match?: (msg: FilterClientMessageByType<ClientMessage, K>) => boolean,
  ): Promise<FilterClientMessageByType<ClientMessage, K>> => {
    return new Promise((resolve, reject) => {
      const handlers = new Map<K, EventListener>();
      let timer: ReturnType<typeof setTimeout>;
      let closeHandler: EventListener | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        for (const [type, handler] of handlers) {
          this.removeEventListener(type, handler);
        }
        handlers.clear();
        if (closeHandler) {
          this.removeEventListener("disconnected", closeHandler);
          closeHandler = undefined;
        }
      };
      for (const type of types) {
        const handler: EventListener = (e) => {
          if (e instanceof MessageEvent) {
            if (match && !match(e.data)) return; // not our response; keep waiting
            cleanup();
            resolve(e.data);
          }
        };
        handlers.set(type, handler);
        this.addEventListener(type, handler);
      }
      // Reject promptly if the socket closes mid-wait (audit 13 #312).
      // Without this, a caller (login, joinRoom, etc.) blocks until
      // REQUEST_TIMEOUT_MS (15s) on every reconnect-mid-request, freezing
      // the UI on a reply that the new socket will never get. The close
      // path's caller can decide whether to retry or surface a toast.
      closeHandler = () => {
        cleanup();
        reject(new Error(`Socket closed waiting for a server reply (${types.join(" / ")})`));
      };
      this.addEventListener("disconnected", closeHandler);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for a server reply (${types.join(" / ")})`));
      }, REQUEST_TIMEOUT_MS);
    });
  };

  // Three-step request pattern: wait for the socket OPEN, send the
  // outbound message, then await the matching reply. Audit 15 #390
  // consolidated eight nearly-identical request methods (login,
  // logout, joinRoom, joinOrCreateRoom, leaveRoom, createRoom,
  // requestFilters, requestFilterValues) behind this single helper.
  // Each caller dropped from a 5-line boilerplate to a single
  // this.request(...) delegating call; the shared correctness
  // invariant (open-socket gate before send, close-event rejection
  // mid-wait, 15s timeout) lives in one place now.
  // requestFilterValues additionally passes a matcher to correlate
  // the key-bearing response with its caller.
  private async request<K extends ClientMessage["type"]>(
    msg: ServerMessage,
    replyTypes: K[],
    match?: (msg: FilterClientMessageByType<ClientMessage, K>) => boolean,
  ): Promise<FilterClientMessageByType<ClientMessage, K>> {
    // Bound the wait-for-open phase (audit 16 #450). waitForConnected
    // never rejects on its own, so a request dispatched during an outage
    // used to park forever with no per-request feedback -- each Login
    // click queued another send that fired whenever the socket finally
    // reconnected, possibly minutes later. Racing against the same
    // REQUEST_TIMEOUT_MS the reply phase uses routes the failure into
    // the caller's existing catch (toast). The {once} "connected"
    // listener waitForConnected registered stays behind on timeout;
    // it resolves an unreferenced promise later, which is harmless.
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.waitForConnected(),
        new Promise((_, reject) => {
          connectTimer = setTimeout(
            () => reject(new Error(`Not connected to the server (waited ${REQUEST_TIMEOUT_MS}ms)`)),
            REQUEST_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(connectTimer);
    }
    this.sendMessage(msg);
    return await this.waitForAnyMessage(replyTypes, match);
  }

  login = async (login: Login) =>
    this.request({ type: "login", payload: login }, ["loginSuccess", "loginError"]);

  logout = async () =>
    this.request({ type: "logout" }, ["logoutSuccess", "logoutError"]);

  joinRoom = async (joinRoomRequest: JoinRoomRequest) => {
    // Reset the sentRateIds set: a new room has its own per-room ratings
    // map server-side, so a card the user rated in a prior room should
    // be ratable again here. Caveat: auto-rejoin (audit 4 #17 / 0.3.19)
    // also flows through this path, so the dedup memory does NOT
    // survive a reconnect; the server's storeRating "already rated"
    // guard + the 0.5.20 pendingRates dedup are the remaining defenses
    // for that window.
    this.sentRateIds.clear();
    return this.request(
      { type: "joinRoom", payload: joinRoomRequest },
      ["joinRoomSuccess", "joinRoomError"],
    );
  };

  // The server takes one of two paths internally; we race all four possible
  // outcomes so callers can await a definitive resolution.
  joinOrCreateRoom = async (joinRoomRequest: JoinRoomRequest) => {
    this.sentRateIds.clear();
    return this.request(
      { type: "joinOrCreateRoom", payload: joinRoomRequest },
      ["joinRoomSuccess", "createRoomSuccess", "joinRoomError", "createRoomError"],
    );
  };

  // Wait for an open socket before sending (request helper does this): a
  // sendMessage on a non-OPEN socket would be dropped and leave the awaited
  // reply unresolved forever if this is called mid-reconnect.
  leaveRoom = async () =>
    this.request({ type: "leaveRoom" }, ["leaveRoomSuccess", "leaveRoomError"]);

  createRoom = async (createRoomRequest: CreateRoomRequest) => {
    this.sentRateIds.clear();
    return this.request(
      { type: "createRoom", payload: createRoomRequest },
      ["createRoomSuccess", "createRoomError"],
    );
  };

  rate = async (rateRequest: Rate) => {
    // Drop dispatches for a mediaId we've already sent in this session.
    // Defense-in-depth against a client-side loop firing rate dispatches
    // for the same card -- see sentRateIds declaration above for the
    // production post-mortem. The card is removed from the deck after a
    // valid swipe, so this only ever drops loop-noise, never a legitimate
    // user action. This gate makes FIRST-decision-wins the app's
    // effective offline semantics -- sendMessage's queue-level
    // replace-with-latest never sees a repeat from this path (audit 16
    // #451).
    if (this.sentRateIds.has(rateRequest.mediaId)) return;
    this.sentRateIds.add(rateRequest.mediaId);
    this.sendMessage({
      type: "rate",
      payload: rateRequest,
    });
  };

  requestFilters = async () =>
    this.request({ type: "requestFilters" }, ["requestFiltersSuccess", "requestFiltersError"]);

  requestFilterValues = async (filterValueRequest: FilterValueRequest) => {
    // Correlate on the filter key: FilterPanel fires one requestFilterValues
    // per key, so several can be in flight at once. Both response shapes echo
    // the key (success: payload.request.key, error: payload.key), so each
    // waiter resolves on its OWN key's response, not whichever arrives first.
    const { key } = filterValueRequest;
    return this.request(
      { type: "requestFilterValues", payload: filterValueRequest },
      ["requestFilterValuesSuccess", "requestFilterValuesError"],
      (msg) =>
        msg.type === "requestFilterValuesSuccess"
          ? msg.payload.request.key === key
          : msg.payload.key === key,
    );
  };

  // Fire-and-forget: there's no `setLocaleSuccess` reply, and the language
  // hint is purely advisory (Plex falls back to English if unrecognized).
  // No awaited response, no caller wants a confirmation -- the WS send is
  // the whole interaction (audit 9 #121).
  setLocale = async (locale: Locale) => {
    await this.waitForConnected();

    this.sendMessage({
      type: "setLocale",
      payload: locale,
    });
  };

  applyFilters = async (payload: { filters: Filter[] }) => {
    // Wait for the socket to be OPEN before sending (audit 13 #313). The
    // prior synchronous version called sendMessage immediately; if a user
    // tapped Apply during a reconnect, the message went to a CLOSED or
    // CLOSING socket and was silently dropped. Now matches the
    // login/logout/setLocale pattern -- await waitForConnected first.
    // Fire-and-forget after the send: the server replies via
    // `filterChangeApplied` to every room member (broadcast), so this
    // caller doesn't need a per-request waiter.
    await this.waitForConnected();
    this.sendMessage({ type: "applyFilters", payload });
  };

  // Cap on queued rate messages. The disconnect-detection gap is brief, so
  // this is only ever a handful in practice; the cap just bounds a pathological
  // case (the oldest queued swipes are dropped past it).
  private static readonly MAX_PENDING_RATES = 50;

  // Set of mediaIds we've already dispatched a `rate` for in this session.
  // Audit 16 / 0.5.22 follow-up to the 0.5.20 pendingRates dedup: that fix
  // only covered the OFFLINE queue. Production reely 0.5.20 (self-hosted
  // deploy, 2026-05-27 ~02:55 UTC) still tripped the WS 100/10s rate
  // limit because a stuck client fires rate dispatches in a tight loop
  // over an OPEN socket -- each one goes straight to ws.send() with no
  // dedup. This sentinel set bounds the storm at source: once a card is
  // rated, no valid use case for re-rating exists (the card is removed
  // from the deck client-side), so strict drop-on-duplicate is safe.
  // Memory is bounded by the room's media set size; no expiry needed
  // within a session.
  private sentRateIds = new Set<string>();

  sendMessage(msg: ServerMessage) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      // Swiping or tapping while disconnected would call send() on a closed
      // socket -- a synchronous throw that surfaces as an unhandled rejection
      // in async callers (e.g. rate()). A `rate` is a real swipe, so queue it
      // for flush-on-reconnect rather than losing it; other message types are
      // request/response and the caller retries, so just drop them.
      if (msg.type === "rate") {
        // Dedupe by mediaId so a stuck client (key-held-down, render loop,
        // or otherwise looping rate dispatches against the same card while
        // offline) can't fill the queue with 50 copies of the same vote.
        // Post-mortem from production reely 0.5.9 (self-hosted deploy,
        // 2026-05-27 ~02:30 UTC): the same mediaId showed up 95+ times in
        // the server log as "already rated" warnings, traced to repeated
        // queue-flushes of all-same-mediaId entries across reconnect
        // cycles.
        //
        // Contract note (audit 16 #451): through the production entry
        // point -- rate(), the only caller that sends rates -- a repeat
        // mediaId is dropped by sentRateIds BEFORE reaching this queue,
        // so the app's effective semantics are FIRST-decision-wins and
        // this replace branch is unreachable. It stays as queue-layer
        // defense in depth (a direct sendMessage caller, or a future
        // relaxation of rate()'s dedup for an undo feature, hits it);
        // at this layer the latest entry wins.
        const mediaId = msg.payload.mediaId;
        const dupIdx = this.pendingRates.findIndex(
          (m) => m.msg.type === "rate" && m.msg.payload.mediaId === mediaId,
        );
        const entry = { msg, roomName: this.currentRoomName };
        if (dupIdx !== -1) {
          this.pendingRates[dupIdx] = entry;
        } else {
          this.pendingRates.push(entry);
          if (this.pendingRates.length > ReelyClient.MAX_PENDING_RATES) {
            this.pendingRates.shift();
          }
        }
        console.warn(`Queued "rate" while disconnected (${this.pendingRates.length} pending)`);
      } else {
        console.warn(`Dropped "${msg.type}" message: WebSocket not open`);
      }
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }
}
