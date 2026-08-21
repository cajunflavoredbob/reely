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

// Per-connection fixed-window rate limit: fits a swipe burst, blunts a flood.
const MSG_RATE_WINDOW_MS = 10_000;
const MSG_RATE_MAX = 100;

// Handlers that read identity or membership, await slow I/O, then commit what
// they read. An interleaved frame would change it underneath them.
const SERIALIZED_MESSAGE_TYPES = new Set<ServerMessage['type']>([
  'login',
  'logout',
  'createRoom',
  'joinRoom',
  'joinOrCreateRoom',
  'leaveRoom',
  'applyFilters',
]);

// Memory backstop for frames queued behind an in-flight handler, not a rate
// limiter: above MSG_RATE_MAX so the limiter pushes back first. Drops here cost
// the user a 15s request() timeout on a live-looking screen.
const MAX_QUEUED_MESSAGES = MSG_RATE_MAX + 28;

// Covers a WAN ping round-trip without noticeably stalling a colliding join.
const SOCKET_PROBE_TIMEOUT_MS = 2000;

// readyState catches closing sockets; the ping catches half-open zombies that
// still report OPEN until the 30s ping sweep in app.ts notices a missed pong.
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

  // See MSG_RATE_* above.
  private msgWindowStart = Date.now();
  private msgCount = 0;
  private msgRateLogged = false;

  // Serialises SERIALIZED_MESSAGE_TYPES. Handlers are async and one TCP read
  // can carry several frames, so overlapping chains would commit state captured
  // before a multi-second await: membership under a stale username that no
  // cleanup can remove, filters on the wrong room, a joiner on a swept room.
  // Close is queued too, so it cannot run before an in-flight join commits a
  // member that nothing can then remove.
  private dispatchQueue: Promise<void> = Promise.resolve();
  private queueDepth = 0;
  private queueFullLogged = false;

  // Cooldown lives on the room (Room.lastApplyAt) so two browser windows can't
  // bypass it.
  private static readonly APPLY_COOLDOWN_MS = 3000;

  constructor(ws: WebSocket, providers: RouteContext['providers']) {
    this.ws = ws;
    this.ctx = { providers };

    this.ws.on('message', (data) => this.handleRawMessage(data.toString()));
    // Bypasses the depth cap: a dropped close leaks the membership the queued
    // frames are about to create.
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
      // Base URL only, never the token. The frontend probes it for
      // direct-to-Plex reachability; withheld when exposePlexBaseUrl is false,
      // which routes every "Open in Plex" link through app.plex.tv. `!== false`
      // so a config built without the field still exposes.
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
        // Optional; without it the frontend can't build "Open in Plex" links.
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

    // Only handlers carrying identity or membership across an await need the
    // queue. Serialising everything is worse:
    //   - FilterPanel fires one requestFilterValues per row at once and
    //     getFilterValues is unmemoized, so serial execution turns max(plex)
    //     into sum(plex) past the 15s client timeout.
    //   - A swipe queued behind a slow applyFilters gets dropped or fails the
    //     media.has guard, but the client already pruned the card, so the
    //     progress bar never agrees with the deck.
    // handleRate checks membership before its first await; setLocale and the
    // filter handlers touch no connection state.
    if (SERIALIZED_MESSAGE_TYPES.has(message.type)) {
      this.enqueue(() => this.dispatch(message, messageText));
    } else {
      void this.dispatch(message, messageText);
    }
  }

  // Appends to this connection's serial queue; returns immediately.
  private enqueue(task: () => void | Promise<void>, bypassCap = false): void {
    if (!bypassCap && this.queueDepth >= MAX_QUEUED_MESSAGES) {
      // Only reachable with a handler parked on slow I/O; unbounded queueing
      // would turn one slow Plex fetch into an unbounded memory hold. Log once
      // per parked run, or a full queue warns per dropped frame.
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
      // An escaping rejection would poison every task queued after it.
      .catch((err) => logger.error(`Unhandled error in queued task: ${String(err)}`))
      .finally(() => {
        this.queueDepth -= 1;
      });
  }

  private async dispatch(message: ServerMessage, messageText: string) {
    // The socket may have closed while this frame waited its turn.
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
    // Not `getUsername()!`: the invariant is unenforceable, and a violation
    // would broadcast the literal string "undefined" as a username.
    const userName = this.getUsername();
    if (!userName) {
      throw new Error('getUser() called without a logged-in user');
    }
    return { userName };
  }

  private handleLogin(login: Login) {
    logger.debug(`Handling login: ${JSON.stringify(login)}`);
    // Untrusted payload: a missing userName throws inside sanitizeInput, gets
    // swallowed by the dispatch catch, and hangs the client awaiting a reply.
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
      // Leave under the old identity so the old name doesn't linger as a ghost.
      // No save needed: users is not a persisted field.
      this.leaveRoomCleanup();
      // Do NOT delete the old name's userProgress. Its ratings and userRated
      // entry are persisted and survive, so dropping progress alone reports
      // 0 of 200 while getMediaForUser still hides the rated cards, capping the
      // user below 100%. Dropping the ratings too would dissolve other people's
      // matches.
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
    // The ownership check inside matters here: a soft-refresh race must not
    // kick the new connection.
    this.leaveRoomCleanup();
    this.isLoggedIn = false;
    this.userName = undefined;
    this.sendMessage({ type: 'logoutSuccess' });
  }

  // Canonical (lowercased, allowlist-stripped) plus display (case-preserved)
  // names. Idempotent, but call it once per request so join-or-create does not
  // double up.
  private sanitizeRoomReq<T extends { roomName: string }>(req: T): T & { displayName: string } {
    return {
      ...req,
      roomName: sanitizeRoomNameCanonical(req.roomName),
      displayName: sanitizeRoomNameDisplay(req.roomName),
    };
  }

  /** True when this connection is the live entry for `userName` in `room`. */
  private ownsMembership(room: Room, userName = this.getUsername()): boolean {
    return userName !== undefined && room.users.get(userName) === this;
  }

  /**
   * Commit this connection as a member of `room`, or refuse and report why.
   *
   * Create and join both arrive here after multi-second awaits, so:
   * - If the socket closed, handleClose already ran with `this.room` undefined
   *   and cleaned up nothing; committing creates a member nothing can remove,
   *   the user count never reaches zero, and the room and its file leak.
   * - If the room left the registry, this connection attaches to an orphan
   *   whose queued save (keyed by room name) overwrites the live room's file.
   */
  private commitMembership(
    room: Room,
    userName: string,
    // Join only: a just-created room cannot be swept (the sweep needs zero
    // users and an old lastSwipeAt), so the check would assert nothing there.
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
    // A crafted client can join while still in another room. The old room would
    // keep a ghost entry that pins it past the TTL sweep and locks the username
    // until restart. After the refusals, so a rejected commit changes nothing.
    if (this.room && this.room !== room) this.leaveRoomCleanup();
    this.room = room;
    room.users.set(userName, this);
    void saveRoom(room);
    return true;
  }

  // Untrusted-payload guard: string roomName, sanitized, non-empty canonical
  // form. On failure sends the create- or join-flavored error and returns
  // undefined.
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
    // Create/join filters would otherwise skip isValidFilter entirely, on the
    // one path that also PERSISTS them: a `<` operator corrupts to an equality
    // query in filterToQueryString (operator.slice(0, -1)), and loadRoom
    // replays it on every restart.
    const filters = (sanitized as { filters?: unknown }).filters;
    if (filters !== undefined) {
      if (!Array.isArray(filters) || !filters.every(isValidFilter)) {
        logger.warn(`${this.getUsername() ?? 'client'} sent a room request with invalid filters`);
        // No error-name union member fits a malformed request, so the detail
        // has to ride in the message the UI renders.
        sendError(
          'Those filters could not be read. Clear them and try again.',
        );
        return undefined;
      }
    }
    return sanitized;
  }

  // Pre: roomName sanitized and non-empty, userName set. Throws typed errors
  // (RoomExistsError, NoMediaError) so callers can branch.
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

  // Pre: roomName sanitized and non-empty, userName set. Throws on failure.
  private async joinRoomFromSanitized(
    sanitizedReq: JoinRoomRequest,
    userName: string,
  ): Promise<void> {
    if (!hasRoom(sanitizedReq.roomName)) {
      const loaded = await loadRoom(sanitizedReq.roomName, this.ctx);
      // Another client may have loaded the same room during the await.
      if (loaded && !hasRoom(sanitizedReq.roomName)) addRoom(loaded);
    }

    const room = getRoom(sanitizedReq.roomName);
    // Reject a username held by a different connection so a second device picks
    // a new name instead of silently displacing the first. `=== this` is a
    // same-session rejoin. this.room is assigned only after this check: a
    // rejected joiner holding a room reference could wipe the active user's
    // userProgress on a rename, and could apply filters to a room it never
    // entered.
    const existing = room.users.get(userName);
    if (existing && existing !== this) {
      // After an unclean drop (phone sleep, network switch) a stale Client
      // holds the name on an OPEN-looking socket for up to ~60s, blocking the
      // user's own auto-rejoin. Only a live holder rejects the join.
      const responsive = await isSocketResponsive(existing.ws);
      // The holder may have cleaned itself up during the probe, or another
      // connection took the slot (a fresh join implies liveness).
      const holder = room.users.get(userName);
      if (holder && holder !== this) {
        if (holder !== existing || responsive) {
          throw new UsernameTakenError(
            `"${userName}" is already in this room. Pick a different name.`,
          );
        }
        // terminate() fires close on a later tick, after users.set has replaced
        // the slot, so the old client's ownership check skips the eviction.
        holder.ws.terminate();
      }
    }
    if (!this.commitMembership(room, userName, { verifyRegistered: true })) {
      // Answer, or the client's request() waiter sits through its full 15s
      // timeout on a live-looking room screen.
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
    // safeProgress guards mediaSize === 0: dividing would put Infinity on the
    // wire and break progress UI consumers.
    const progress = safeProgress(userProgress, mediaSize);
    room.notifyJoin({ user: this.getUser(), progress });
  }

  private emitJoinError(err: unknown) {
    // joinOrCreateRoom's disk-load path can throw RoomLimitError from addRoom;
    // without an entry here the user gets the generic "unexpected error" copy.
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
    // The instanceof check makes the cast sound. Anything else maps to
    // UnknownError rather than leaking an err.name outside the protocol union.
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

  // Join if the room exists, create if not, in one round-trip. Sanitizes once;
  // the inner methods expect already-cleaned payloads.
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

    // A RoomExistsError from the create branch means another client won the
    // race; retry as a join. The probe sits inside the try so addRoom's
    // RoomLimitError becomes an error response instead of an unhandled throw.
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
        // Lost the create race; retry as join.
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
   * Detach this connection from its room, returning the prior Room since the
   * detach clears `this.room`. Sends nothing back, so handleClose can call it
   * with the socket already gone.
   */
  private leaveRoomCleanup(): Room | undefined {
    const userName = this.getUsername();
    const room = this.room;
    if (!room || !userName) return undefined;
    // Only mutate if this connection still owns the username: after a soft
    // refresh the new Client owns the entry, and evicting it or broadcasting a
    // leave would kick the live connection.
    if (this.ownsMembership(room, userName)) {
      room.users.delete(userName);
      room.notifyLeave(this.getUser());
    }
    // Detach regardless of the ownership check: this Client is leaving, so
    // handleRate must not keep rating the old room.
    this.room = undefined;
    return room;
  }

  private handleLeaveRoom() {
    if (this.leaveRoomCleanup()) {
      this.sendMessage({ type: 'leaveRoomSuccess' });
    } else {
      this.sendMessage({ type: 'leaveRoomError', payload: { errorType: 'NOT_JOINED' } });
    }
  }

  private async handleRate(rate: Rate) {
    const userName = this.getUsername();
    const room = this.room;
    if (!userName || !room) return;
    // Only mutate if this connection still owns the username in this room; a
    // stale handler would otherwise corrupt ratings for a room the user left.
    if (!this.ownsMembership(room, userName)) return;
    // Untrusted payload: reading mediaId on null would throw and be swallowed.
    if (!rate || typeof rate.mediaId !== 'string') return;
    if (rate.rating !== 'like' && rate.rating !== 'dislike') return;
    const media = await room.media;
    if (!media.has(rate.mediaId)) return;
    // `rate` is deliberately not serialised, so a leave can land while this is
    // parked on the media promise. Narrows the window without closing it
    // (storeRating awaits this.media again); the residue is a real rating plus
    // a progress frame the client's reducer ignores.
    if (!this.ownsMembership(room, userName)) return;
    await room.storeRating(userName, rate, Date.now());
    // Debounced persist so a crash before disconnect doesn't lose recent swipes.
    scheduleSaveRoom(room);
  }

  private async handleSetLocale(locale: Locale) {
    // Untrusted payload: guard the shape before reading locale.language.
    if (!locale || typeof locale.language !== 'string') return;
    // The locale isn't stored on the Client; it only selects the bundle.
    // loadTranslation is memoized, so repeats don't re-read the file.
    const translations = await loadTranslation(locale.language);
    this.sendMessage({ type: 'translations', payload: translations as Translations });
  }

  private handleClose() {
    logger.info(`${this.getUsername() ?? 'Unknown user'} disconnected.`);
    // Cleanup-only: the socket is gone, so leaveRoomSuccess would just log
    // "tried to send to a disconnected client" on every clean disconnect. Save
    // via the returned room; this.room is always undefined after the detach.
    const previousRoom = this.leaveRoomCleanup();
    if (previousRoom) void saveRoom(previousRoom);
  }

  private async handleRequestFilters() {
    // Login gate: without it a peer that only completed the WS upgrade can
    // enumerate every genre, studio, director and collection in the library,
    // and basicAuth is off by default. The UI only reaches filters from inside
    // a room.
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
        // A throw with no reply leaves waitForAnyMessage unresolved and the
        // FilterPanel stuck on "Loading filters..." forever.
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
    // Login gate: see handleRequestFilters. The amplifying half; every call is
    // proxied to Plex, bounded only by the per-connection limiter.
    if (!this.isLoggedIn) {
      // Echo the key: the client correlates by key, so an empty one matches no
      // waiter and the row hangs until its own timeout.
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
    // Untrusted payload: a null one would throw and leave the client waiting.
    if (!filterValueRequest || typeof filterValueRequest.key !== 'string') {
      this.sendMessage({ type: 'requestFilterValuesError', payload: { key: '', message: 'Invalid filter request.' } });
      return;
    }
    const key = filterValueRequest.key;
    // api.ts interpolates the key straight into a Plex URL path: no separators
    // or traversal sequences.
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
    // Same membership gate handleRate carries.
    const gateUserName = this.getUsername();
    if (!this.ownsMembership(this.room, gateUserName)) return;
    // Validate the outer shape before destructuring: a bad message should log,
    // not throw a swallowed TypeError.
    if (
      !payload ||
      typeof payload !== 'object' ||
      !Array.isArray((payload as { filters?: unknown }).filters)
    ) {
      logger.warn(`${this.getUsername()} sent applyFilters with invalid payload shape`);
      // applyFilters is fire-and-forget client-side, so a silent drop leaves
      // the panel looking applied while the room never changed.
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

    // biome-ignore lint/style/noNonNullAssertion: gated by isLoggedIn upstream.
    const appliedBy = this.getUsername()!;
    logger.debug(`Filters applied by ${appliedBy} (${this.room.users.size} user(s) in room)`);

    try {
      const media = await this.room.applyFilters(filters);
      // null means a newer apply superseded this one mid-fetch: skip notify and
      // save so a stale media set isn't broadcast.
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

  // Past this much queued outbound data the client is stuck or the network is
  // congested. Terminate and let it auto-reconnect rather than buffer forever.
  private static readonly MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

  sendMessage(msg: ClientMessage): void {
    this.sendRaw(JSON.stringify(msg));
  }

  // Pre-stringified path for Room.broadcastMessage: encode once, forward to N
  // users instead of re-encoding per user.
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
