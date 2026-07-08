import { WebSocket } from 'ws';
import type {
  ClientMessage,
  CreateRoomError,
  CreateRoomRequest,
  Filter,
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

// Bounds chosen to comfortably fit any legitimate Plex filter from the UI while
// preventing a malicious WS message from passing huge strings through to the
// Plex query layer.
const MAX_FILTER_KEY_LEN = 64;
const MAX_FILTER_VALUES = 32;
const MAX_FILTER_VALUE_LEN = 128;

// Per-connection WebSocket message rate limit (fixed window). Generous enough
// for rapid swiping plus the burst of messages on room join, tight enough to
// blunt a flood (e.g. repeated createRoom). Messages over the cap are dropped.
const MSG_RATE_WINDOW_MS = 10_000;
const MSG_RATE_MAX = 100;

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

const isValidFilter = (f: unknown): f is Filter =>
  f !== null &&
  typeof f === 'object' &&
  typeof (f as Filter).key === 'string' &&
  (f as Filter).key.length > 0 &&
  (f as Filter).key.length <= MAX_FILTER_KEY_LEN &&
  /^[a-z0-9_.-]+$/i.test((f as Filter).key) &&
  typeof (f as Filter).operator === 'string' &&
  // Every operator the UI can send ends with '='. Plex natively emits
  // the date "is before" operator as a bare '<<', but the provider
  // normalizes it to '<<=' before it ships to the client (audit 16
  // #449), so the '='-terminated invariant holds here by construction.
  // filterToQueryString strips the trailing '=' before appending to the
  // key, so a bare '<' or '>' would corrupt to an equality query.
  /^[!<>=~]{0,2}=$/.test((f as Filter).operator) &&
  Array.isArray((f as Filter).value) &&
  (f as Filter).value.length > 0 &&
  (f as Filter).value.length <= MAX_FILTER_VALUES &&
  (f as Filter).value.every(
    (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_FILTER_VALUE_LEN,
  );

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

  // Cooldown enforcement lives on the room (Room.lastApplyAt) so it can't be
  // bypassed by opening two browser windows.
  private static readonly APPLY_COOLDOWN_MS = 3000;

  constructor(ws: WebSocket, providers: RouteContext['providers']) {
    this.ws = ws;
    this.ctx = { providers };

    this.ws.on('message', (data) => this.handleRawMessage(data.toString()));
    this.ws.on('close', () => this.handleClose());
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
      // other clients (so the old name doesn't linger as a ghost), then we
      // drop the stale userProgress entry on the prior room and persist so
      // the saved snapshot doesn't carry the orphaned entry.
      const previousName = this.userName;
      const previousRoom = this.leaveRoomCleanup();
      if (previousRoom) {
        previousRoom.userProgress.delete(previousName);
        void saveRoom(previousRoom);
      }
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
    // A crafted client can send createRoom while already in a room; the
    // standard frontend always leaves first. Without this cleanup the old
    // room keeps a ghost users entry that pins it past the TTL sweep and
    // locks the username there until restart. Runs after createRoom so a
    // failed create leaves the current membership untouched. (audit 16 #422)
    if (this.room && this.room !== room) this.leaveRoomCleanup();
    this.room = room;
    room.users.set(userName, this);
    void saveRoom(room);
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
    // A crafted client can join while already in a different room; the
    // standard frontend always leaves first. Without this cleanup the old
    // room keeps a ghost users entry that pins it past the TTL sweep and
    // locks the username there until restart. Runs after the collision
    // check so a rejected join leaves the current membership untouched.
    // (audit 16 #422)
    if (this.room && this.room !== room) this.leaveRoomCleanup();
    this.room = room;
    room.users.set(userName, this);
    void saveRoom(room);
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

  // Evict this client from the room and notify the rest, if applicable. Pure
  // cleanup -- no message is sent back to the leaving client. Safe to call
  // from handleClose where the socket is already closed.
  //
  // Returns the room this client was evicted from (or undefined if it wasn't
  // in one) so callers can decide what to do with the prior room reference --
  // mutate userProgress on a rename, save it on disconnect, etc. Audit 15
  // #376: before that batch the method returned `boolean` and handleClose's
  // `if (this.room) saveRoom(...)` follow-up was dead because leaveRoomCleanup
  // had already cleared this.room. Returning the Room reference surfaces it
  // before the detach so the disconnect-time save actually fires now.
  private leaveRoomCleanup(): Room | undefined {
    const userName = this.getUsername();
    const room = this.room;
    if (!room || !userName) return undefined;
    // Only mutate the room if this client is still the active connection for
    // this username. If the user reconnected (e.g. soft refresh) before the
    // old WS close event fired, the new Client has already replaced this entry
    // and we must not evict it or broadcast a spurious leave.
    if (room.users.get(userName) === this) {
      room.users.delete(userName);
      room.notifyLeave(this.getUser());
    }
    // Detach this.room regardless of the active-connection check: this Client
    // is leaving by request, so handleRate must not continue applying ratings
    // to the old room afterward.
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
    // Defense in depth on top of the leave/logout `this.room = undefined`
    // detachment: only mutate room state if this Client is still the
    // active connection for this user in this room. A stale handler --
    // or any future code path that forgets to detach this.room -- would
    // otherwise be able to corrupt ratings for a room the user isn't in.
    if (room.users.get(userName) !== this) return;
    // Untrusted payload: a malformed message ({} or null) would otherwise
    // throw on rate.mediaId and be swallowed by the handleRawMessage catch.
    if (!rate || typeof rate.mediaId !== 'string') return;
    if (rate.rating !== 'like' && rate.rating !== 'dislike') return;
    const media = await room.media;
    if (!media.has(rate.mediaId)) return;
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
    const previousRoom = this.leaveRoomCleanup();
    if (previousRoom) void saveRoom(previousRoom);
  }

  private async handleRequestFilters() {
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
    if (!gateUserName || this.room.users.get(gateUserName) !== this) return;
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
