import { WebSocket } from 'ws';
import type {
  ClientMessage,
  CreateRoomError,
  CreateRoomRequest,
  FilterValueRequest,
  JoinRoomError,
  JoinRoomRequest,
  Locale,
  Login,
  ProviderType,
  Rate,
  ServerMessage,
  Translations,
  User,
} from '../../../types/reely';
import {
  addRoom,
  createRoom,
  getRoom,
  hasRoom,
  isRegisteredRoom,
  NoMediaError,
  type Room,
  RoomExistsError,
  RoomLimitError,
  RoomNotFoundError,
  safeProgress,
  UsernameTakenError,
} from './room';
import { loadRoom, saveRoom, scheduleSaveRoom } from './roomStore';
import {
  sanitizeInput,
  sanitizeRoomNameCanonical,
  sanitizeRoomNameDisplay,
} from './util/sanitize';
import { getConfig } from './config/main';
import type { RouteContext } from './types';
import { loadTranslation } from './i18n';
import { logger } from './logger';
import { isValidFilter } from './util/filters';

// Per-connection WebSocket message rate limit (fixed window). Generous enough
// for rapid swiping plus the burst of messages on room join, tight enough to
// blunt a flood (e.g. repeated createRoom). Messages over the cap are dropped.
const MSG_RATE_WINDOW_MS = 10_000;
const MSG_RATE_MAX = 100;

// Message types that must not overlap on one connection. These are the
// handlers that read identity or room membership, await something slow (a
// Plex fetch, a disk load, the liveness probe), and then commit using what
// they read: an interleaved frame changes the world underneath them. Everything
// else runs concurrently, as it always did.
const SERIALIZED_MESSAGE_TYPES = new Set<ServerMessage['type']>([
  'login',
  'logout',
  'createRoom',
  'joinRoom',
  'joinOrCreateRoom',
  'leaveRoom',
  'applyFilters',
]);

// Ceiling on frames waiting behind an in-flight handler: a memory backstop,
// not a second rate limiter. Set above MSG_RATE_MAX so the limiter is the
// thing that pushes back within a window rather than this. It is not a
// guarantee: a handler parked longer than MSG_RATE_WINDOW_MS lets the limiter
// roll into a fresh window and admit another MSG_RATE_MAX, so a drop here is
// still possible, just no longer the FIRST thing to fire. That matters because
// every serialized type except applyFilters is sent through the frontend's
// request(), which resolves only on a reply, so a dropped frame costs the user
// a 15s wait on a live-looking screen.
const MAX_QUEUED_MESSAGES = MSG_RATE_MAX + 28;

// Deadline for the collision liveness probe below. Comfortably covers a WAN
// ping round-trip without stalling a colliding join noticeably.
const SOCKET_PROBE_TIMEOUT_MS = 2000;

// Probe a socket's liveness with a short-deadline ping. readyState catches
// sockets already closing; the ping round-trip catches half-open zombies
// (peer vanished without a FIN) that still report OPEN until the 30s ping
// sweep in app.ts notices the missed pong. (audit 16 #421)
const isSocketResponsive = (ws: WebSocket): Promise<boolean> =>
  new Promise((resolve) => {
    if (ws.readyState !== WebSocket.OPEN) {
      resolve(false);
      return;
    }
    const onPong = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      ws.off('pong', onPong);
      resolve(false);
    }, SOCKET_PROBE_TIMEOUT_MS);
    ws.once('pong', onPong);
    try {
      ws.ping();
    } catch {
      // OPEN -> CLOSING race between the check above and the ping call.
      clearTimeout(timer);
      ws.off('pong', onPong);
      resolve(false);
    }
  });

export class Client {
  ws: WebSocket;
  ctx: RouteContext;
  room?: Room;
  userName?: string;
  isLoggedIn = false;

  // Fixed-window message rate limiting -- see MSG_RATE_* above.
  private msgWindowStart = Date.now();
  private msgCount = 0;
  private msgRateLogged = false;

  // Serialises the handlers in SERIALIZED_MESSAGE_TYPES above; everything
  // else still runs concurrently. `ws.on('message')` fires once
  // per frame as it arrives and the handlers are async, so a single TCP read
  // carrying login+joinOrCreateRoom+login used to start three overlapping
  // handler chains. The room-mutating handlers capture state (userName, the
  // Room, membership) BEFORE multi-second awaits -- Plex fetches, disk loads,
  // the socket liveness probe -- and commit it AFTER, so an interleaved frame
  // could change the world underneath them: entries keyed by a stale username
  // that no cleanup path could ever remove, filters applied to whichever room
  // the client had since joined, a joiner attached to a room the TTL sweep
  // had already collected.
  //
  // Close is queued too, deliberately. It has to run after any in-flight
  // join/create rather than racing it, or cleanup runs while `this.room` is
  // still undefined and the join commits a member nothing can remove
  // afterwards.
  private dispatchQueue: Promise<void> = Promise.resolve();
  private queueDepth = 0;
  private queueFullLogged = false;

  // Cooldown enforcement lives on the room (Room.lastApplyAt) so it can't be
  // bypassed by opening two browser windows.
  private static readonly APPLY_COOLDOWN_MS = 3000;

  constructor(ws: WebSocket, providers: RouteContext['providers']) {
    this.ws = ws;
    this.ctx = { providers };

    this.ws.on('message', (data) => this.handleRawMessage(data.toString()));
    // Bypasses the depth cap: dropping a close would leak the membership the
    // queued frames are about to create.
    this.ws.on('close', () => this.enqueue(() => this.handleClose(), true));
    this.ws.on('error', (err) => logger.error(`WebSocket error: ${err.message}`));

    this.sendConfig();
  }

  private async sendConfig() {
    const config = getConfig();
    const requiresConfiguration = config.servers.length === 0;
    let serverName: string | undefined;
    let providerType: ProviderType | undefined;
    let plexServerId: string | undefined;
    let plexBaseUrl: string | undefined;
    if (!requiresConfiguration && this.ctx.providers.length > 0) {
      const provider = this.ctx.providers[0];
      providerType = provider.type;
      // The configured Plex base URL (no token -- token lives separately in
      // the server-side config and is never exposed to the browser). The
      // frontend uses it to probe for direct-to-Plex link reachability.
      //
      // Gated by exposePlexBaseUrl (default true). When false, the field is
      // withheld; the frontend's probe resolves to false for an undefined
      // URL, so all "Open in Plex" links route through app.plex.tv. (audit
      // 10 #165 / audit 12 #226.) `!== false` (instead of truthy) so a
      // missing field still exposes -- applyDefaults fills `true`, but
      // belt-and-suspenders for any direct construction.
      if (config.exposePlexBaseUrl !== false) {
        plexBaseUrl = provider.options.url;
      }
      try {
        serverName = await provider.getName();
      } catch {
        // server name is optional; ignore fetch failures
      }
      try {
        plexServerId = await provider.getServerId();
      } catch {
        // server id is optional; without it the frontend just can't build
        // "Open in Plex" links. Ignore fetch failures.
      }
    }
    this.sendMessage({
      type: 'config',
      payload: {
        requiresConfiguration,
        ...(serverName ? { serverName } : {}),
        ...(providerType ? { providerType } : {}),
        ...(plexServerId ? { plexServerId } : {}),
        ...(plexBaseUrl ? { plexBaseUrl } : {}),
      },
    });
  }

  private async handleRawMessage(messageText: string) {
    if (this.ws.readyState !== WebSocket.OPEN) return;

    const now = Date.now();
    if (now - this.msgWindowStart >= MSG_RATE_WINDOW_MS) {
      this.msgWindowStart = now;
      this.msgCount = 0;
      this.msgRateLogged = false;
    }
    this.msgCount += 1;
    if (this.msgCount > MSG_RATE_MAX) {
      // Log once per window so a flood can't also flood the log.
      if (!this.msgRateLogged) {
        this.msgRateLogged = true;
        logger.warn(
          `WebSocket message rate limit exceeded (${MSG_RATE_MAX} per ${MSG_RATE_WINDOW_MS}ms); dropping further messages this window.`,
        );
      }
      return;
    }

    let message: ServerMessage;
    try {
      message = JSON.parse(messageText);
    } catch (err) {
      logger.error(`Failed to parse message: ${messageText} -- ${String(err)}`);
      return;
    }

    // Only the handlers that carry identity or room membership across an await
    // need the queue. Serialising everything made two things worse than the
    // race it fixed:
    //
    //   - FilterPanel deliberately fires one requestFilterValues per row at
    //     once, and getFilterValues is the one provider call with no memo, so
    //     back-to-back execution turned max(plex) into sum(plex) against a
    //     fixed 15s client timeout: the trailing rows time out and fall back
    //     to raw ids.
    //   - A swipe queued behind a multi-second applyFilters could be dropped
    //     by the depth cap, or run after the refetch and fail the media.has
    //     guard. Either way the rating is lost, the client has already pruned
    //     the card and recorded the id in sentRateIds, and the progress bar
    //     permanently disagrees with the deck.
    //
    // handleRate captures userName and room into locals and checks membership
    // before its first await, so it is race-safe on its own. setLocale touches
    // no connection state, and the two filter handlers are read-only against
    // the provider. None of them belong in the queue.
    if (SERIALIZED_MESSAGE_TYPES.has(message.type)) {
      this.enqueue(() => this.dispatch(message, messageText));
    } else {
      void this.dispatch(message, messageText);
    }
  }

  // Append `task` to this connection's serial queue. Returns immediately; the
  // task runs once everything queued before it has settled.
  private enqueue(task: () => void | Promise<void>, bypassCap = false): void {
    if (!bypassCap && this.queueDepth >= MAX_QUEUED_MESSAGES) {
      // Only reachable when a handler is parked on slow I/O, since the rate
      // limiter above already bounds arrivals. Dropping is the same outcome
      // the rate limiter produces, and unbounded queueing would turn one slow
      // Plex fetch into an unbounded memory hold.
      // Log once per parked run, the same guard the rate-limit drop above
      // carries: a full queue would otherwise emit one warn per dropped frame.
      if (!this.queueFullLogged) {
        this.queueFullLogged = true;
        logger.warn(
          `Dispatch queue full (${MAX_QUEUED_MESSAGES}) for ${this.getUsername() ?? 'anonymous client'}; dropping messages until it drains.`,
        );
      }
      return;
    }
    this.queueFullLogged = false;
    this.queueDepth += 1;
    this.dispatchQueue = this.dispatchQueue
      .then(task)
      // Catch inside the chain: an escaping rejection would poison every
      // task queued after it, silently wedging the connection.
      .catch((err) => logger.error(`Unhandled error in queued task: ${String(err)}`))
      .finally(() => {
        this.queueDepth -= 1;
      });
  }

  private async dispatch(message: ServerMessage, messageText: string) {
    // Re-checked here, not just on arrival: the socket may have closed while
    // this frame waited its turn behind a slow handler.
    if (this.ws.readyState !== WebSocket.OPEN) return;
    try {
      switch (message.type) {
        case 'login': await this.handleLogin(message.payload); break;
        case 'logout': this.handleLogout(); break;
        case 'createRoom': await this.handleCreateRoom(message.payload); break;
        case 'joinRoom': await this.handleJoinRoom(message.payload); break;
        case 'joinOrCreateRoom': await this.handleJoinOrCreateRoom(message.payload); break;
        case 'leaveRoom': this.handleLeaveRoom(); break;
        case 'rate': await this.handleRate(message.payload); break;
        case 'setLocale': await this.handleSetLocale(message.payload); break;
        case 'requestFilters': await this.handleRequestFilters(); break;
        case 'requestFilterValues': await this.handleRequestFilterValues(message.payload); break;
        case 'applyFilters': await this.handleApplyFilters(message.payload); break;
        default: logger.info(`Unhandled message: ${messageText}`);
      }
    } catch (err) {
      logger.error(`Error handling ${message.type}: ${String(err)}`);
    }
  }

  getUsername() {
    return this.userName;
  }

  getUser(): User {
    // Explicit check rather than `getUsername()!`. The non-null assertion
    // was correct under the intended call pattern (only invoked from
    // handlers that gate on isLoggedIn), but it relied on an out-of-band
    // invariant -- and the type system can't enforce it. Throwing here
    // surfaces a violation cleanly instead of synthesizing a User with
    // `userName: undefined as string`, which would propagate through
    // broadcasts as the literal string "undefined".
    const userName = this.getUsername();
    if (!userName) {
      throw new Error('getUser() called without a logged-in user');
    }
    return { userName };
  }

  private handleLogin(login: Login) {
    logger.debug(`Handling login: ${JSON.stringify(login)}`);
    // The payload is untrusted JSON -- a malformed message ({} or a missing
    // userName) would otherwise throw inside sanitizeInput, get swallowed by
    // the handleRawMessage catch, and hang the client awaiting a response.
    if (!login || typeof login.userName !== 'string') {
      this.sendMessage({
        type: 'loginError',
        payload: { name: 'MalformedMessage', message: 'A username is required.' },
      });
      return;
    }
    const sanitizedUserName = sanitizeInput(login.userName);
    if (!sanitizedUserName) {
      this.sendMessage({
        type: 'loginError',
        payload: { name: 'MalformedMessage', message: 'Username must not be empty.' },
      });
      return;
    }
    if (this.userName && sanitizedUserName !== this.userName) {
      // Username is changing while possibly in a room. Cleanly leave under the
      // old identity: leaveRoomCleanup evicts this connection and notifies the
      // other clients, so the old name doesn't linger as a ghost.
      // No save here. leaveRoomCleanup mutates only room.users and broadcasts,
      // and users is not a persisted field, so writing the file would change
      // nothing but updatedAt. The userProgress delete this diff removed was
      // the only persisted mutation on this path.
      this.leaveRoomCleanup();
      // The old code deleted previousRoom.userProgress[previousName]
      // here, and nothing else. The user's ratings and their entry in the
      // userRated reverse index both stayed, and both are persisted and
      // rebuilt on every restart -- so rejoining under the old name reported
      // 0 of 200 while getMediaForUser still filtered the deck against the
      // surviving rated set, handing back 150 cards. The user could swipe
      // every remaining card and never pass 75%. Deleting the rest instead
      // is worse: their likes are half of any match the room already found,
      // so purging them would silently dissolve other people's matches. The
      // progress entry is what keeps the surviving state coherent, so it
      // stays.
    }
    this.userName = sanitizedUserName;
    this.isLoggedIn = true;
    this.sendMessage({
      type: 'loginSuccess',
      payload: { userName: sanitizedUserName },
    });
  }

  private handleLogout() {
    if (!this.userName) {
      this.sendMessage({
        type: 'logoutError',
        payload: { name: 'NotLoggedIn', message: 'This connection does not have a logged in user.' },
      });
      return;
    }
    // leaveRoomCleanup encapsulates the active-connection check + notify +
    // detach this.room sequence; audit 15 #376 had handleLogout duplicating
    // that body inline. The active-connection check matters here too: a
    // soft-refresh race must not kick the new connection.
    this.leaveRoomCleanup();
    this.isLoggedIn = false;
    this.userName = undefined;
    this.sendMessage({ type: 'logoutSuccess' });
  }

  // Shared sanitize step for room requests. Derives the canonical (lowercased,
  // allowlist-stripped) name + the display (case-preserved) form from the
  // user-typed input. Idempotent, but we still want to call it exactly once
  // per inbound request so the join-or-create path doesn't double up.
  private sanitizeRoomReq<T extends { roomName: string }>(req: T): T & { displayName: string } {
    return {
      ...req,
      roomName: sanitizeRoomNameCanonical(req.roomName),
      displayName: sanitizeRoomNameDisplay(req.roomName),
    };
  }

  // Untrusted-payload guard for room requests. Validates that `req` has a
  // string roomName, runs sanitizeRoomReq, and confirms the canonical form
  // is non-empty. On failure sends the appropriate error response (createRoom
  // or join flavor) and returns undefined; on success returns the sanitized +
  // display-named form. Audit 15 #372 consolidated three near-identical guard
  // blocks across handleCreateRoom + handleJoinRoom + handleJoinOrCreateRoom
  // into this single helper. (handleLogin's similar-shape userName validation
  // stays inline -- its sanitize function, error vocabulary, and field name
  // diverge enough that a fully generic helper would have more params than
  // the call sites.)
  /**
   * True when this connection is the live entry for `userName` in `room`.
   *
   * The rule was hand-copied at three call sites in three spellings with no
   * single owner, which is how several of the ghost-membership bugs got in
   * independently. One definition, one place to reason about it.
   */
  private ownsMembership(room: Room, userName = this.getUsername()): boolean {
    return userName !== undefined && room.users.get(userName) === this;
  }

  /**
   * Commit this connection as a member of `room`, or refuse and report why.
   *
   * Both the create and join paths reach here after multi-second awaits (a
   * Plex library fetch, a disk load, the socket liveness probe), and both used
   * to commit unconditionally. Two things can have changed underneath them:
   *
   * - The socket closed. `handleClose` already ran and found `this.room` still
   *   undefined, so it cleaned up nothing; the commit then created a member
   *   that no later event could remove. Close is once-only, cleanup only runs
   *   from inbound messages a dead socket cannot send, and the ping sweep
   *   iterates `wss.clients`, which no longer holds it. The room's user count
   *   never returns to zero, so the TTL sweep skips it forever and the room
   *   and its file leak until restart.
   * - The room left the registry. The TTL sweep can collect a room while a
   *   joiner is parked in the liveness probe, leaving the joiner attached to
   *   an orphan: a later joiner builds a second divergent Room under the same
   *   name, and because pending saves are keyed by room name the orphan's
   *   queued save overwrites the live room's file.
   */
  private commitMembership(
    room: Room,
    userName: string,
    // Join only. The create path receives a Room that createRoom just
    // registered, and a room created moments ago cannot be swept (the sweep
    // needs zero users AND an old lastSwipeAt), so re-reading the registry
    // there would assert nothing and would couple create to a lookup it
    // deliberately avoids.
    { verifyRegistered = false }: { verifyRegistered?: boolean } = {},
  ): boolean {
    if (this.ws.readyState !== WebSocket.OPEN) {
      logger.info(
        `${userName} disconnected before the room commit; not adding them to "${room.roomName}".`,
      );
      return false;
    }
    if (verifyRegistered && !isRegisteredRoom(room)) {
      logger.warn(
        `Room "${room.roomName}" was replaced or expired while ${userName} was joining; refusing the commit.`,
      );
      return false;
    }
    // A crafted client can create/join while already in another room; the
    // standard frontend always leaves first. Without this the old room keeps a
    // ghost users entry that pins it past the TTL sweep and locks the username
    // there until restart. Runs only once the commit is certain, so a refused
    // one leaves the current membership untouched. (audit 16 #422)
    if (this.room && this.room !== room) this.leaveRoomCleanup();
    this.room = room;
    room.users.set(userName, this);
    void saveRoom(room);
    return true;
  }

  private validateRoomRequest<T extends { roomName: string }>(
    req: T,
    errorType: 'createRoomError' | 'joinRoomError',
  ): (T & { displayName: string }) | undefined {
    const sendError = (message: string) => {
      if (errorType === 'createRoomError') {
        this.sendMessage({
          type: 'createRoomError',
          payload: { name: 'InvalidRoomNameError', message },
        });
      } else {
        this.sendMessage({
          type: 'joinRoomError',
          payload: { name: 'RoomNotFoundError', message },
        });
      }
    };
    if (!req || typeof req.roomName !== 'string') {
      sendError('Room name must not be empty.');
      return undefined;
    }
    const sanitized = this.sanitizeRoomReq(req);
    if (!sanitized.roomName) {
      sendError('Room name must not be empty.');
      return undefined;
    }
    // Filters arriving on a create/join request went completely unchecked:
    // isValidFilter was applied only on the applyFilters path, so every cap
    // that exists for this reason -- MAX_FILTER_KEY_LEN, MAX_FILTER_VALUES,
    // MAX_FILTER_VALUE_LEN, the key and operator regexes -- was bypassed by
    // the one path that also PERSISTS what it is given. A `<` operator
    // corrupts to an equality query in filterToQueryString (which does
    // operator.slice(0, -1)), the exact case the invariant above exists to
    // prevent, and because the room file is replayed by loadRoom the bad
    // query came back on every restart.
    const filters = (sanitized as { filters?: unknown }).filters;
    if (filters !== undefined) {
      if (!Array.isArray(filters) || !filters.every(isValidFilter)) {
        logger.warn(`${this.getUsername() ?? 'client'} sent a room request with invalid filters`);
        // The error `name` unions have no member for a malformed request, so
        // the shared helper's name is wrong for this condition either way; the
        // message is what the UI renders, so make that one carry the detail.
        sendError(
          'Those filters could not be read. Clear them and try again.',
        );
        return undefined;
      }
    }
    return sanitized;
  }

  // Inner create path. Pre: sanitizedReq.roomName is non-empty and already
  // sanitized; userName is set. Throws on any failure (RoomExistsError,
  // NoMediaError, etc.) so callers can branch on error type.
  private async createRoomFromSanitized(
    sanitizedReq: CreateRoomRequest,
    userName: string,
  ): Promise<void> {
    const room = await createRoom(sanitizedReq, this.ctx);
    if (!this.commitMembership(room, userName)) return;
    this.sendMessage({
      type: 'createRoomSuccess',
      payload: {
        roomName: room.roomName,
        displayName: room.displayName,
        previousMatches: await room.getMatches(userName, false),
        media: await room.getMediaForUser(userName),
        users: await room.getUsers(),
        filters: room.filters,
      },
    });
  }

  // Inner join path. Pre: sanitizedReq.roomName is non-empty and already
  // sanitized; userName is set. Throws on failure.
  private async joinRoomFromSanitized(
    sanitizedReq: JoinRoomRequest,
    userName: string,
  ): Promise<void> {
    if (!hasRoom(sanitizedReq.roomName)) {
      const loaded = await loadRoom(sanitizedReq.roomName, this.ctx);
      // Re-check after the await: another client may have loaded the same room concurrently.
      if (loaded && !hasRoom(sanitizedReq.roomName)) addRoom(loaded);
    }

    const room = getRoom(sanitizedReq.roomName);
    // 0.5.22: reject same-username-different-connection collisions at the
    // room boundary so a second device picks a new name instead of silently
    // displacing the first (prior behavior left the displaced client
    // dead-looking + the active one in a rate-storm-prone state). `=== this`
    // is the re-join-in-same-session case (legitimate; just refresh the
    // slot).
    //
    // this.room is assigned only after the collision check passes: a
    // rejected joiner must not keep a reference to a room it never entered
    // (audit 16 #419 -- the reference let a follow-up login-rename wipe the
    // active user's userProgress via leaveRoomCleanup's returned room, and
    // let the non-member apply filters to the room).
    const existing = room.users.get(userName);
    if (existing && existing !== this) {
      // Liveness probe (audit 16 #421): after an unclean drop (phone sleep,
      // network switch) the stale Client holds the name with an OPEN-looking
      // socket until the ping sweep terminates it (up to ~60s), blocking the
      // same user's own auto-rejoin. Only a demonstrably live holder rejects
      // the join; a dead one is displaced like the pre-0.5.22 behavior.
      const responsive = await isSocketResponsive(existing.ws);
      // Re-check after the await: the holder may have closed and cleaned
      // itself up meanwhile, or a different connection may have taken the
      // slot (a fresh join implies liveness -- reject without re-probing).
      const holder = room.users.get(userName);
      if (holder && holder !== this) {
        if (holder !== existing || responsive) {
          throw new UsernameTakenError(
            `"${userName}" is already in this room. Pick a different name.`,
          );
        }
        // Dead holder: displace it. terminate() emits its close event on a
        // later tick -- after users.set below has replaced the slot -- so
        // the old client's leaveRoomCleanup identity guard skips the
        // eviction/broadcast (same shape as the soft-refresh race).
        holder.ws.terminate();
      }
    }
    if (!this.commitMembership(room, userName, { verifyRegistered: true })) {
      // Answer, or the client's request() waiter has nothing to resolve on and
      // sits through its full 15s timeout showing a live-looking room screen.
      // Only worth sending on the registry branch: if the socket closed there
      // is nobody left to receive it.
      if (this.ws.readyState === WebSocket.OPEN) {
        this.sendMessage({
          type: 'joinRoomError',
          payload: {
            name: 'RoomNotFoundError',
            message: `The room "${room.displayName}" expired while you were joining. Try again.`,
          },
        });
      }
      return;
    }
    this.sendMessage({
      type: 'joinRoomSuccess',
      payload: {
        roomName: room.roomName,
        displayName: room.displayName,
        previousMatches: await room.getMatches(userName, false),
        media: await room.getMediaForUser(userName),
        users: await room.getUsers(),
        filters: room.filters,
      },
    });

    const userProgress = room.userProgress.get(userName) ?? 0;
    const mediaSize = (await room.media).size;
    // safeProgress guards mediaSize === 0 (normally impossible -- fetchMedia
    // throws NoMediaError on empty -- but a future code path could leave
    // room.media empty and userProgress / 0 would yield Infinity on the
    // wire, breaking progress UI consumers).
    const progress = safeProgress(userProgress, mediaSize);
    room.notifyJoin({ user: this.getUser(), progress });
  }

  private emitJoinError(err: unknown) {
    // joinOrCreateRoom's disk-load path can throw RoomLimitError from
    // addRoom -- the comment at the call site acknowledges this. Without
    // an allowlist entry here, the user saw the generic "unexpected
    // error" copy instead of the real "room limit reached" message.
    // emitCreateError already covers RoomLimitError; mirror it here
    // (audit 11 #177). JoinRoomError's name union was widened to
    // carry RoomLimitError in 0.4.9.
    let name: JoinRoomError['name'];
    let message: string;
    if (err instanceof RoomNotFoundError) {
      name = 'RoomNotFoundError';
      message = err.message;
    } else if (err instanceof RoomLimitError) {
      name = 'RoomLimitError';
      message = err.message;
    } else if (err instanceof UsernameTakenError) {
      name = 'UsernameTakenError';
      message = err.message;
    } else {
      name = 'UnknownError';
      message = 'An unexpected error occurred while joining the room. Please try again.';
    }
    this.sendMessage({ type: 'joinRoomError', payload: { name, message } });
  }

  private emitCreateError(err: unknown) {
    const isKnownError =
      err instanceof RoomExistsError ||
      err instanceof RoomLimitError ||
      err instanceof NoMediaError;
    // Only a known error's name is a valid CreateRoomError name -- the
    // instanceof check above guarantees that, so the cast is sound. An
    // unknown error (TypeError, plain Error) maps to UnknownError rather
    // than leaking an arbitrary err.name outside the protocol's union.
    const name: CreateRoomError['name'] = isKnownError
      ? ((err as Error).name as CreateRoomError['name'])
      : 'UnknownError';
    const message = isKnownError
      ? (err as Error).message
      : 'An unexpected error occurred while creating the room. Please try again.';
    this.sendMessage({ type: 'createRoomError', payload: { name, message } });
    logger.error(String(err));
  }

  private async handleCreateRoom(createRoomReq: CreateRoomRequest) {
    const userName = this.getUsername();
    if (!userName) {
      this.sendMessage({
        type: 'createRoomError',
        payload: { name: 'NotLoggedInError', message: 'You must be logged in to create a room.' },
      });
      return;
    }
    const sanitizedReq = this.validateRoomRequest(createRoomReq, 'createRoomError');
    if (!sanitizedReq) return;
    try {
      await this.createRoomFromSanitized(sanitizedReq, userName);
    } catch (err) {
      this.emitCreateError(err);
    }
  }

  private async handleJoinRoom(joinRoomReq: JoinRoomRequest) {
    if (!this.isLoggedIn) {
      this.sendMessage({
        type: 'joinRoomError',
        payload: { name: 'NotLoggedInError', message: 'You must log in before joining a room.' },
      });
      return;
    }
    const userName = this.getUsername();
    if (!userName) {
      // Defensive: isLoggedIn should imply userName is set.
      this.sendMessage({
        type: 'joinRoomError',
        payload: { name: 'UnknownError', message: 'Inconsistent login state.' },
      });
      return;
    }
    const sanitizedReq = this.validateRoomRequest(joinRoomReq, 'joinRoomError');
    if (!sanitizedReq) return;
    try {
      await this.joinRoomFromSanitized(sanitizedReq, userName);
    } catch (err) {
      this.emitJoinError(err);
    }
  }

  // Single-button "start screening" flow: join if the room exists, create if
  // not. Replaces the older client pattern of speculatively joining and then
  // auto-creating on RoomNotFoundError -- one round-trip, no swallowed errors.
  // Sanitizes the inbound request once and hands the cleaned payload to the
  // inner join/create methods (which would otherwise re-sanitize redundantly).
  private async handleJoinOrCreateRoom(req: JoinRoomRequest) {
    if (!this.isLoggedIn) {
      this.sendMessage({
        type: 'joinRoomError',
        payload: { name: 'NotLoggedInError', message: 'You must log in before joining a room.' },
      });
      return;
    }
    const userName = this.getUsername();
    if (!userName) {
      this.sendMessage({
        type: 'joinRoomError',
        payload: { name: 'UnknownError', message: 'Inconsistent login state.' },
      });
      return;
    }
    const sanitizedReq = this.validateRoomRequest(req, 'joinRoomError');
    if (!sanitizedReq) return;

    // Probe the in-memory and on-disk room indexes; take the join path if
    // found, otherwise try create. A RoomExistsError from the create branch
    // is a race -- another client created the room between our probe and our
    // attempt -- and we recover by retrying as a join. The probe is inside
    // the try so a RoomLimitError from addRoom (disk-load past MAX_ROOMS)
    // surfaces as a proper error response instead of an unhandled throw.
    let exists = hasRoom(sanitizedReq.roomName);
    try {
      if (!exists) {
        const loaded = await loadRoom(sanitizedReq.roomName, this.ctx);
        if (loaded) {
          if (!hasRoom(sanitizedReq.roomName)) addRoom(loaded);
          exists = true;
        }
      }
      if (exists) {
        await this.joinRoomFromSanitized(sanitizedReq, userName);
      } else {
        await this.createRoomFromSanitized(sanitizedReq, userName);
      }
    } catch (err) {
      if (err instanceof RoomExistsError) {
        // Lost the create race -- another client got there first. Retry as join.
        logger.debug(`joinOrCreate: create lost a race for "${sanitizedReq.roomName}", retrying as join`);
        try {
          await this.joinRoomFromSanitized(sanitizedReq, userName);
        } catch (joinErr) {
          this.emitJoinError(joinErr);
        }
      } else if (exists) {
        this.emitJoinError(err);
      } else {
        this.emitCreateError(err);
      }
    }
  }

  /**
   * Detach this connection from its room.
   *
   * Pure cleanup: no message goes back to the leaving client, so this is safe
   * to call from handleClose where the socket is already gone. Audit 15 #376
   * made it surface the prior Room (it used to return boolean, which left
   * handleClose's `if (this.room) saveRoom(...)` dead, since the detach had
   * already cleared it).
   *
   * Reports `evicted` separately from `room`: callers used to treat a
   * truthy return as "this connection was removed", but it only ever meant
   * "this connection had a room". When the identity guard below declines --
   * a soft-refresh race where a newer Client already owns the slot -- the old
   * behaviour still handed the room back, and the rename path then deleted
   * the progress of the connection that legitimately owned the name.
   */
  private leaveRoomCleanup(): { room?: Room; evicted: boolean } {
    const userName = this.getUsername();
    const room = this.room;
    if (!room || !userName) return { evicted: false };
    // Only mutate the room if this client is still the active connection for
    // this username. If the user reconnected (e.g. soft refresh) before the
    // old WS close event fired, the new Client has already replaced this entry
    // and we must not evict it or broadcast a spurious leave.
    let evicted = false;
    if (this.ownsMembership(room, userName)) {
      room.users.delete(userName);
      room.notifyLeave(this.getUser());
      evicted = true;
    }
    // Detach this.room regardless of the active-connection check: this Client
    // is leaving by request, so handleRate must not continue applying ratings
    // to the old room afterward.
    this.room = undefined;
    return { room, evicted };
  }

  private handleLeaveRoom() {
    if (this.leaveRoomCleanup().room) {
      this.sendMessage({ type: 'leaveRoomSuccess' });
    } else {
      this.sendMessage({ type: 'leaveRoomError', payload: { errorType: 'NOT_JOINED' } });
    }
  }

  private async handleRate(rate: Rate) {
    const userName = this.getUsername();
    const room = this.room;
    if (!userName || !room) return;
    // Defense in depth on top of the leave/logout `this.room = undefined`
    // detachment: only mutate room state if this Client is still the
    // active connection for this user in this room. A stale handler --
    // or any future code path that forgets to detach this.room -- would
    // otherwise be able to corrupt ratings for a room the user isn't in.
    if (!this.ownsMembership(room, userName)) return;
    // Untrusted payload: a malformed message ({} or null) would otherwise
    // throw on rate.mediaId and be swallowed by the handleRawMessage catch.
    if (!rate || typeof rate.mediaId !== 'string') return;
    if (rate.rating !== 'like' && rate.rating !== 'dislike') return;
    const media = await room.media;
    if (!media.has(rate.mediaId)) return;
    // Re-check after the await: `rate` is deliberately not serialised, so a
    // leaveRoom or logout can complete while this one is parked on the media
    // promise. This narrows that window rather than closing it -- storeRating
    // awaits this.media again internally, so a leave landing inside THAT await
    // still records the rating. The residue is benign: the trailing progress
    // frame is addressed to a user the client's reducer no longer lists, so it
    // is a no-op there, and the rating itself is one the user did make.
    if (!this.ownsMembership(room, userName)) return;
    await room.storeRating(userName, rate, Date.now());
    // Persist after rating activity (debounced) so a crash before disconnect
    // doesn't lose recent swipes/matches.
    scheduleSaveRoom(room);
  }

  private async handleSetLocale(locale: Locale) {
    // Untrusted payload: guard the shape before reading locale.language.
    if (!locale || typeof locale.language !== 'string') return;
    // (The locale isn't stored on the Client -- it's only used to fetch
    // the matching translations bundle. Audit 12 #227 removed a `this.locale`
    // field that was written here but never read anywhere.)
    // loadTranslation is memoized -- avoids repeated file reads for the same locale.
    const translations = await loadTranslation(locale.language);
    this.sendMessage({ type: 'translations', payload: translations as Translations });
  }

  private handleClose() {
    logger.info(`${this.getUsername() ?? 'Unknown user'} disconnected.`);
    // Use the cleanup-only path: the socket is already closed, so emitting
    // leaveRoomSuccess would just produce a noisy "tried to send to a
    // disconnected client" warning on every clean disconnect. Capture the
    // prior room from the helper's return so the save below actually runs
    // -- before audit 15 #376 this method called leaveRoomCleanup() (which
    // sets this.room = undefined on success) and then checked
    // `if (this.room) saveRoom(...)` -- always false; the disconnect-time
    // save never fired.
    const { room: previousRoom } = this.leaveRoomCleanup();
    if (previousRoom) void saveRoom(previousRoom);
  }

  private async handleRequestFilters() {
    // Every other provider- or room-touching handler gates on login; these two
    // did not, so a peer that only completed the WS upgrade could enumerate
    // every genre, studio, director, actor, collection and label in the
    // library, with each requestFilterValues proxied straight to Plex. On a
    // deployment without basicAuth (the documented default, which app.ts only
    // warns about) that was a pre-auth enumeration and amplification surface.
    // The UI only reaches filters from inside a room, so nothing legitimate
    // asks before logging in.
    if (!this.isLoggedIn) {
      this.sendMessage({
        type: 'requestFiltersError',
        payload: { message: 'You must be logged in to browse filters.' },
      });
      return;
    }
    if (this.ctx.providers.length) {
      const [provider] = this.ctx.providers;
      try {
        const filters = await provider.getFilters();
        this.sendMessage({ type: 'requestFiltersSuccess', payload: filters });
      } catch (err) {
        // Without this catch a getFilters() throw sends nothing back, leaving
        // the frontend's waitForAnyMessage unresolved and the FilterPanel
        // stuck on "Loading filters..." forever. Mirror handleRequestFilterValues.
        logger.error(`getFilters() failed: ${String(err)}`);
        this.sendMessage({
          type: 'requestFiltersError',
          payload: { message: 'Failed to fetch filters.' },
        });
      }
    } else {
      this.sendMessage({ type: 'requestFiltersError', payload: { message: 'No media providers are configured. Check your server settings.' } });
    }
  }

  private async handleRequestFilterValues(filterValueRequest: FilterValueRequest) {
    // Login gate: see handleRequestFilters. This is the amplifying half --
    // every call is proxied to Plex, bounded only by the per-connection
    // 100-per-10s limiter, so 20 sockets per IP could drive 2000 Plex
    // round-trips per 10s from a peer with no identity.
    if (!this.isLoggedIn) {
      // Echo the requested key: the client correlates this reply by key, so an
      // empty one matches no waiter and the row hangs on "Loading values..."
      // until its own timeout fires with the wrong message.
      const key =
        filterValueRequest && typeof filterValueRequest.key === 'string'
          ? filterValueRequest.key
          : '';
      this.sendMessage({
        type: 'requestFilterValuesError',
        payload: { key, message: 'You must be logged in to browse filters.' },
      });
      return;
    }
    // Untrusted payload: guard the shape before reading .key (a null payload
    // would otherwise throw and leave the client awaiting a response).
    if (!filterValueRequest || typeof filterValueRequest.key !== 'string') {
      this.sendMessage({ type: 'requestFilterValuesError', payload: { key: '', message: 'Invalid filter request.' } });
      return;
    }
    const key = filterValueRequest.key;
    // Reject keys that contain path separators or traversal sequences -- the key
    // is interpolated directly into a Plex API URL path in api.ts.
    if (!/^[a-z0-9_-]+$/i.test(key)) {
      this.sendMessage({ type: 'requestFilterValuesError', payload: { key, message: 'Invalid filter key.' } });
      return;
    }
    if (this.ctx.providers.length) {
      const [provider] = this.ctx.providers;
      try {
        const filterValues = await provider.getFilterValues(key);
        this.sendMessage({
          type: 'requestFilterValuesSuccess',
          payload: { request: filterValueRequest, values: filterValues },
        });
      } catch (err) {
        logger.error(`getFilterValues("${key}") failed: ${String(err)}`);
        this.sendMessage({
          type: 'requestFilterValuesError',
          payload: { key, message: 'Failed to fetch filter values.' },
        });
      }
    } else {
      this.sendMessage({ type: 'requestFilterValuesError', payload: { key, message: 'No media providers are configured. Check your server settings.' } });
    }
  }

  private async handleApplyFilters(payload: unknown) {
    if (!this.room || !this.isLoggedIn) return;
    // Same defense-in-depth membership gate handleRate carries: only mutate
    // room state if this Client is still the active connection for this user
    // in this room. (audit 16 #419)
    const gateUserName = this.getUsername();
    if (!this.ownsMembership(this.room, gateUserName)) return;
    // The wire might deliver a malformed payload (null, missing field, wrong
    // type). Validate the outer shape before destructuring so a bad message
    // produces a logged warning instead of a silently-swallowed TypeError.
    if (
      !payload ||
      typeof payload !== 'object' ||
      !Array.isArray((payload as { filters?: unknown }).filters)
    ) {
      logger.warn(`${this.getUsername()} sent applyFilters with invalid payload shape`);
      // Answer instead of silently returning (audit 16 #449): applyFilters
      // is fire-and-forget client-side, so a silent drop left the panel
      // looking applied while the room never changed. The other two
      // failure paths (cooldown, fetch error) already send this.
      this.sendMessage({
        type: 'filterChangeError',
        payload: { message: 'Invalid filter payload.' },
      });
      return;
    }
    const filters = (payload as { filters: unknown[] }).filters;
    if (!filters.every(isValidFilter)) {
      logger.warn(`${this.getUsername()} sent invalid filter payload`);
      this.sendMessage({
        type: 'filterChangeError',
        payload: { message: 'Invalid filter payload.' },
      });
      return;
    }

    const now = Date.now();
    const sinceLast = now - this.room.lastApplyAt;
    if (sinceLast < Client.APPLY_COOLDOWN_MS) {
      logger.warn(
        `applyFilters throttled in room "${this.room.roomName}" by ${this.getUsername()} (${sinceLast}ms since last; cooldown ${Client.APPLY_COOLDOWN_MS}ms)`,
      );
      this.sendMessage({
        type: 'filterChangeError',
        payload: { message: 'Please wait a moment before applying filters again.' },
      });
      return;
    }
    this.room.lastApplyAt = now;

    // getUsername returns the captured anonymousUserName; callers of
    // handleApplyFilters have already gated on isLoggedIn (which
    // implies username is set). Non-null is the invariant.
    // biome-ignore lint/style/noNonNullAssertion: gated by isLoggedIn upstream.
    const appliedBy = this.getUsername()!;
    logger.debug(`Filters applied by ${appliedBy} (${this.room.users.size} user(s) in room)`);

    try {
      const media = await this.room.applyFilters(filters);
      // applyFilters returns null when a newer apply superseded this one
      // mid-fetch -- skip notify + save so we don't broadcast a stale
      // media/filter set after the room moved on.
      if (media !== null) {
        this.room.notifyFilterApplied(appliedBy, media, filters);
        void saveRoom(this.room);
      }
    } catch (err) {
      this.sendMessage({
        type: 'filterChangeError',
        payload: { message: err instanceof NoMediaError ? err.message : 'Failed to apply filters.' },
      });
    }
  }

  // Beyond this much queued outbound data the WS is unhealthy -- either the
  // client is stuck or the network is fully congested. Terminate and let the
  // client auto-reconnect to re-sync state cleanly instead of buffering
  // unboundedly server-side.
  private static readonly MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

  sendMessage(msg: ClientMessage): void {
    this.sendRaw(JSON.stringify(msg));
  }

  // Pre-stringified path used by Room.broadcastMessage so a single payload
  // is encoded once and forwarded to N users instead of re-encoded per user
  // (audit 12 #201). The connection-state + backpressure guards are
  // identical to sendMessage.
  sendRaw(json: string): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('Tried to send message to a disconnected client');
      return;
    }
    if (this.ws.bufferedAmount > Client.MAX_BUFFERED_BYTES) {
      logger.warn(
        `Terminating WS for ${this.getUsername() ?? 'unknown'} due to send-buffer backpressure (${this.ws.bufferedAmount} bytes queued)`,
      );
      this.ws.terminate();
      return;
    }
    this.ws.send(json);
  }
}
