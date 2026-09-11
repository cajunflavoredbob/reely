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

// Uptime before a connection counts as healthy and resets the reconnect
// backoff. Stops an accept-then-close crash loop retrying at the base delay
// forever.
const STABLE_CONNECTION_MS = 10_000;

// Reply deadline. Stops a dropped reply hanging the promise, and the UI.
const REQUEST_TIMEOUT_MS = 15_000;

// Reply deadline for the requests that put a user in a room. Those block on
// the server's first provider fetch, which budgets 30s per HTTP call with one
// retry and a short backoff, so a cold read of a large library legitimately
// runs past a minute. At REQUEST_TIMEOUT_MS the user gets "the server isn't
// responding" and then watches the join succeed anyway, because the
// joinRoomSuccess still arrives and drops them into the room behind the toast.
const ROOM_REQUEST_TIMEOUT_MS = 75_000;

/**
 * Error whose message is safe to show the user verbatim.
 *
 * The store's catch-all toast blames the server, which is wrong for a
 * condition the user caused. Tagged rather than assumed, so internal text
 * never reaches the UI.
 */
export class UserFacingError extends Error {
  readonly userFacing = true;
}

export class ReelyClient extends EventTarget {
  ws!: WebSocket;
  reconnectionAttempts = 0;
  private stableConnectionTimer?: ReturnType<typeof setTimeout>;
  // Swipes made while the socket was down, flushed on the next open. Bounded
  // by count so a long outage can't grow it without limit, and by age so a
  // tab that slept for hours can't replay yesterday's votes.
  //
  // Each entry carries its room so a flush can't replay it into a DIFFERENT
  // room: all rooms draw from one library, so the server's media.has() guard
  // would take the cross-room vote as legitimate. Untagged entries (queued
  // before any join) flush unconditionally.
  private pendingRates: Array<{
    msg: ServerMessage;
    roomName?: string;
    queuedAt: number;
  }> = [];

  // Canonical name of the current room; tags queued rates.
  private currentRoomName?: string;

  // Bumped on every socket construction. currentRoomName survives a reconnect,
  // so room affinity alone cannot tell a send on the original connection from
  // one on a brand-new socket that has not logged in or rejoined yet, and the
  // server drops that second kind on the floor with no reply.
  private connectionEpoch = 0;

  // Handler waiting to flush pendingRates on the next post-reconnect
  // join/createRoomSuccess. On the instance so each reconnect cycle replaces
  // the previous one; repeated reconnects without a rejoin would otherwise
  // grow the EventTarget listener list unboundedly.
  private flushAfterRejoinHandler?: EventListener;

  constructor() {
    super();
    // Rate-queue room affinity: track the current room to tag queued rates,
    // and drop all rate state when the session ends. An offline swipe from a
    // room the user left must not flush into the next room, nor be credited
    // to the next user on a shared device.
    this.addEventListener("joinRoomSuccess", this.captureRoomName);
    this.addEventListener("createRoomSuccess", this.captureRoomName);
    this.addEventListener("leaveRoomSuccess", this.clearRateState);
    this.addEventListener("logoutSuccess", this.clearRateState);
    // Registered here, not in handleOpen, so it runs BEFORE that reconnect's
    // flush listener: the flush deliberately re-records the ids it replays and
    // must not have them reconciled back off again.
    this.addEventListener("joinRoomSuccess", this.reconcileRatedIds);
    this.addEventListener("createRoomSuccess", this.reconcileRatedIds);
    this.addEventListener("filterChangeApplied", this.reconcileRatedIds);
    this.connect();
  }

  private captureRoomName = (e: Event) => {
    if (!(e instanceof MessageEvent)) return;
    const data = (e as MessageEvent<ClientMessage>).data;
    if (data.type === "joinRoomSuccess" || data.type === "createRoomSuccess") {
      this.currentRoomName = data.payload.roomName;
    }
  };

  // Let server truth overrule the local dedup memory. `media` on these frames
  // is already filtered by what THIS user has rated, so an id still in it was
  // never recorded server-side: the `rate` was dropped (sent before the join
  // finished, or past the server's WS rate limit) while sentRateIds recorded
  // it at send time. filterChangeApplied then puts the card back in the deck,
  // where every re-swipe is silently eaten and the progress bar never moves.
  // Forgetting those ids makes the card ratable again.
  private reconcileRatedIds = (e: Event) => {
    if (!(e instanceof MessageEvent)) return;
    const data = (e as MessageEvent<ClientMessage>).data;
    if (
      data.type !== "joinRoomSuccess" &&
      data.type !== "createRoomSuccess" &&
      data.type !== "filterChangeApplied"
    ) {
      return;
    }
    // handleMessage shape-guards only `type`, so treat the payload as
    // untrusted rather than throwing inside a dispatchEvent.
    const media = data.payload?.media;
    if (!Array.isArray(media)) return;
    for (const item of media) {
      this.sentRateIds.delete(item.id);
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

    this.connectionEpoch += 1;
    this.ws = new WebSocket(API_URL);
    this.ws.addEventListener("message", this.handleMessage);
    this.ws.addEventListener("close", this.handleClose, { once: true });
    this.ws.addEventListener("open", this.handleOpen, { once: true });
    this.ws.addEventListener("error", this.handleError);
  }

  private handleMessage = (e: MessageEvent<string>) => {
    try {
      // Shape-guard before casting: a bare cast TypeErrors on non-object JSON
      // and silently no-ops on objects with no `type`.
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

    // Wait on our own "connected" event, not the socket's "open": connect()
    // swaps in a new socket, so a listener bound to the dead one never fires.
    return new Promise((resolve) => {
      this.addEventListener("connected", () => resolve(true), { once: true });
    });
  };

  private handleOpen = () => {
    // Do NOT flush queued rates here: the new socket hasn't logged in or
    // rejoined, so the server would drop every one. Flush on the next
    // join-success instead; with no join the queue waits, evicting its oldest
    // past MAX_PENDING_RATES and discarding stale entries when it does flush.
    //
    // Tear down the prior reconnect's listener BEFORE registering this one;
    // every open without a join-success would otherwise leak two listeners.
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
      // Re-queue what we can't send: bailing out on a mid-flush close would
      // lose every swipe after the first failed send. Survivors unshift back
      // to the head, so order holds across reconnects.
      const remaining: typeof queued = [];
      for (const entry of queued) {
        // Age out before the room check: a name match is not proof of the same
        // room. The server destroys an idle room after its TTL and rebuilds a
        // fresh one under that name on the next join, so an overnight queue
        // would otherwise drop day-old votes into a room whose members never
        // saw those cards.
        if (Date.now() - entry.queuedAt > ReelyClient.MAX_PENDING_RATE_AGE_MS) {
          console.warn(`Dropped queued "rate" that outlived the staleness bound`);
          continue;
        }
        // A rate queued in room A must not flush into room B. Untagged
        // entries flush unconditionally.
        if (entry.roomName !== undefined && entry.roomName !== joinedRoom) {
          console.warn(
            `Dropped queued "rate" from room "${entry.roomName}" (rejoined "${joinedRoom}")`,
          );
          continue;
        }
        if (this.ws.readyState === WebSocket.OPEN) {
          // Re-record the dedup id: the join cleared sentRateIds and the
          // server's deck predates these rates, so the user is seeing cards
          // they already voted on. A re-swipe records neither a vote nor
          // progress, drifting the progress bar from the deck.
          if (entry.msg.type === "rate") this.sentRateIds.add(entry.msg.payload.mediaId);
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
    // Reset the backoff only once the connection proves stable: resetting on
    // every `open` lets an accept-then-close crash loop retry at base delay.
    clearTimeout(this.stableConnectionTimer);
    this.stableConnectionTimer = setTimeout(() => {
      this.reconnectionAttempts = 0;
    }, STABLE_CONNECTION_MS);
  };

  // Reconnection is driven by the close handler; this only makes errors visible.
  private handleError = (event: Event) => {
    console.warn("reely WebSocket error", event);
  };

  private handleClose = () => {
    // Never reached "stable"; keep the backoff counter so a crash loop escalates.
    clearTimeout(this.stableConnectionTimer);
    this.dispatchEvent(new Event("disconnected"));

    // Capped exponential backoff with jitter. The cap keeps a down server from
    // being hammered; the jitter breaks lockstep retries after a restart.
    const base = Math.min(30_000, 500 * 2 ** this.reconnectionAttempts);
    const delay = base + Math.random() * 1_000;
    setTimeout(() => this.connect(), delay);

    this.reconnectionAttempts += 1;
  };

  // Wait for any of several message types, with shared cleanup. A Promise.race
  // of per-type {once:true} listeners leaks the unfired ones, which pile up
  // across reconnects and fire on later unrelated messages of that type.
  //
  // Rejects after `timeoutMs` so a dropped reply surfaces as an error instead
  // of hanging the caller; cleanup runs on that path too.
  //
  // `match` correlates a reply to its request. Several requestFilterValues
  // calls run at once (one per filter key), so matching on TYPE alone resolves
  // the wrong waiter. Non-matching messages are ignored and the waiter keeps
  // listening, still timeout-bounded.
  waitForAnyMessage = <K extends ClientMessage["type"]>(
    types: K[],
    match?: (msg: FilterClientMessageByType<ClientMessage, K>) => boolean,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
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
      // Reject on a mid-wait close: the new socket will never receive this
      // reply, so waiting out the full timeout just freezes the UI.
      closeHandler = () => {
        cleanup();
        reject(new Error(`Socket closed waiting for a server reply (${types.join(" / ")})`));
      };
      this.addEventListener("disconnected", closeHandler);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for a server reply (${types.join(" / ")})`));
      }, timeoutMs);
    });
  };

  // Wait for OPEN, send, await the matching reply. Every request method routes
  // through here so the invariants (open-socket gate, close-event rejection,
  // timeout) live in one place.
  private async request<K extends ClientMessage["type"]>(
    msg: ServerMessage,
    replyTypes: K[],
    match?: (msg: FilterClientMessageByType<ClientMessage, K>) => boolean,
    // Reply deadline only. The wait-for-open phase below stays on
    // REQUEST_TIMEOUT_MS: that one is about reaching the server at all, not
    // about how long the server's own work takes.
    replyTimeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<FilterClientMessageByType<ClientMessage, K>> {
    // Bound the wait-for-open phase: waitForConnected never rejects, so a
    // request made during an outage parks forever and fires minutes later on
    // reconnect. The race routes that into the caller's catch (toast). The
    // abandoned {once} "connected" listener resolves an unreferenced promise
    // later, which is harmless.
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
    return await this.waitForAnyMessage(replyTypes, match, replyTimeoutMs);
  }

  login = async (login: Login) =>
    this.request({ type: "login", payload: login }, ["loginSuccess", "loginError"]);

  logout = async () =>
    this.request({ type: "logout" }, ["logoutSuccess", "logoutError"]);

  joinRoom = async (joinRoomRequest: JoinRoomRequest) => {
    // Ratings are per-room server-side, so a card rated elsewhere is ratable
    // here. Caveat: auto-rejoin runs this path too, so the dedup memory does
    // NOT survive a reconnect; the server's already-rated guard and the
    // pendingRates dedup cover that window.
    this.sentRateIds.clear();
    return this.request(
      { type: "joinRoom", payload: joinRoomRequest },
      ["joinRoomSuccess", "joinRoomError"],
      undefined,
      ROOM_REQUEST_TIMEOUT_MS,
    );
  };

  // The server picks join or create, so race all four replies.
  joinOrCreateRoom = async (joinRoomRequest: JoinRoomRequest) => {
    this.sentRateIds.clear();
    return this.request(
      { type: "joinOrCreateRoom", payload: joinRoomRequest },
      ["joinRoomSuccess", "createRoomSuccess", "joinRoomError", "createRoomError"],
      undefined,
      ROOM_REQUEST_TIMEOUT_MS,
    );
  };

  // request() gates on an open socket: a send to a non-OPEN socket is dropped
  // and leaves the awaited reply unresolved forever.
  leaveRoom = async () =>
    this.request({ type: "leaveRoom" }, ["leaveRoomSuccess", "leaveRoomError"]);

  createRoom = async (createRoomRequest: CreateRoomRequest) => {
    this.sentRateIds.clear();
    return this.request(
      { type: "createRoom", payload: createRoomRequest },
      ["createRoomSuccess", "createRoomError"],
      undefined,
      ROOM_REQUEST_TIMEOUT_MS,
    );
  };

  rate = async (rateRequest: Rate) => {
    // Drop repeat mediaIds. A valid swipe removes the card from the deck, so
    // this only ever drops loop noise. It also makes first-decision-wins the
    // effective semantics: sendMessage's replace-with-latest never sees a
    // repeat from here.
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
    // Correlate on the filter key: one call per key runs concurrently, so
    // without this each waiter resolves on whichever reply arrives first.
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

  /**
   * waitForConnected, bounded, for fire-and-forget sends.
   *
   * The bare promise never rejects, so every tap during an outage parks
   * another undedupable {once} "connected" closure and they all fire together
   * on reconnect, minutes later.
   */
  private waitForConnectedWithin = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.waitForConnected(),
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Not connected to the server (waited ${REQUEST_TIMEOUT_MS}ms)`)),
            REQUEST_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // Fire-and-forget: no setLocaleSuccess reply exists and the hint is advisory
  // (Plex falls back to English on an unrecognized locale).
  setLocale = async (locale: Locale) => {
    // Advisory, so a failed wait isn't worth surfacing; just don't park forever.
    try {
      await this.waitForConnectedWithin();
    } catch {
      return;
    }

    this.sendMessage({
      type: "setLocale",
      payload: locale,
    });
  };

  applyFilters = async (payload: { filters: Filter[] }) => {
    // Gate on an open socket, or an Apply tapped mid-reconnect is silently
    // dropped. Fire-and-forget after that: the server broadcasts
    // filterChangeApplied to the whole room, so no waiter is needed.
    //
    // Pinned to the room the apply was made in. The server's membership gate
    // passes wherever the user now is, so a parked apply that fires after a
    // room change applies room A's filters to room B and wipes every member's
    // deck.
    const requestedIn = this.currentRoomName;
    const requestedOn = this.connectionEpoch;
    await this.waitForConnectedWithin();
    // Undefined means no join had completed, so there is no affinity to
    // enforce; same rule as untagged entries in the rate queue.
    if (requestedIn !== undefined && this.currentRoomName !== requestedIn) {
      // Throw, not return: the panel already closed, so a silent drop leaves
      // an unexplained unchanged deck. createStore's catch turns this into a
      // toast.
      throw new UserFacingError(
        `Those filters were for "${requestedIn}", so they were not applied here.`,
      );
    }
    // Same room name, different socket: the wait resumed on "connected", which
    // fires before this connection has logged in or rejoined, so the server
    // would drop the frame at its membership gate without replying. Surface it
    // instead, since one more tap on Apply does work.
    if (this.connectionEpoch !== requestedOn) {
      throw new UserFacingError(
        "The connection dropped before those filters were sent. Please apply them again.",
      );
    }
    this.sendMessage({ type: "applyFilters", payload });
  };

  // Queue cap; the oldest swipes drop past it. Only a pathological case hits it.
  private static readonly MAX_PENDING_RATES = 50;

  // Age cap on a queued swipe, kept well under the server's 6h room TTL so a
  // queued vote can never outlive the room generation it was cast in.
  private static readonly MAX_PENDING_RATE_AGE_MS = 60 * 60 * 1_000;

  // mediaIds already rated this session. Stops a stuck client looping rate
  // dispatches over an OPEN socket from tripping the server's WS rate limit,
  // which the offline-only pendingRates dedup never sees. Safe because a rated
  // card leaves the deck. Bounded by the room's media set; no expiry needed.
  private sentRateIds = new Set<string>();

  sendMessage(msg: ServerMessage) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      // send() on a closed socket throws synchronously, surfacing as an
      // unhandled rejection in async callers. A `rate` is a real swipe, so
      // queue it; other types are request/response and the caller retries.
      if (msg.type === "rate") {
        // Dedupe by mediaId so a stuck client can't fill the queue with 50
        // copies of one vote.
        //
        // Unreachable via rate(), the only production caller, since
        // sentRateIds drops repeats first. Kept as queue-layer defense for a
        // direct sendMessage caller or a future undo feature; at this layer
        // the latest entry wins.
        const mediaId = msg.payload.mediaId;
        const dupIdx = this.pendingRates.findIndex(
          (m) => m.msg.type === "rate" && m.msg.payload.mediaId === mediaId,
        );
        const entry = { msg, roomName: this.currentRoomName, queuedAt: Date.now() };
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
