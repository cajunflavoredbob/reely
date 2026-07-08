import { logger } from './logger';
import type {
  ClientMessage,
  CreateRoomRequest,
  Filter,
  Match,
  Media,
  Rate,
  User,
  UserProgress,
} from '../../../types/reely';
import type { Client } from './client';
import type { RouteContext } from './types';

// Shared empty-set sentinel for the `userRated` reverse-index fallback
// (audit 14 #359). Re-using a single frozen Set avoids allocating a
// fresh one on every getMediaForUser call for users who haven't rated
// anything. Frozen so a future caller can't accidentally mutate it.
const EMPTY_SET: ReadonlySet<string> = Object.freeze(new Set<string>());

// Divide-by-zero-safe progress fraction. Audit 15 #384 consolidated
// three duplicated sites (client.ts handleJoinRoom, room.ts storeRating,
// room.ts getUsers) so they all guard the same way: return 0 when total
// is 0 or negative so the wire value can't become Infinity / NaN on a
// degenerate empty-media room.
//
// Clamped to 1 (audit 16 #439): applyFilters deliberately preserves
// userProgress while media.size can shrink, so count > total is a
// legitimate post-filter state -- without the clamp, fractions like
// 51/40 reached the wire, persisted to disk, and rendered as "128%" in
// UsersPopup (UserPill clamped independently; consumers shouldn't have
// to defend against server-originated bad data one by one).
export const safeProgress = (count: number, total: number): number =>
  total > 0 ? Math.min(1, count / total) : 0;

export class RoomExistsError extends Error { name = 'RoomExistsError'; }
export class RoomLimitError extends Error { name = 'RoomLimitError'; }
export class RoomNotFoundError extends Error { name = 'RoomNotFoundError'; }
export class NoMediaError extends Error { name = 'NoMediaError'; }
// Thrown when a join request tries to add a connection under a username
// that's already taken by a DIFFERENT live connection in the same room.
// Audit 16 / 0.5.22: production reely saw "Lance" used on two devices
// simultaneously (Android phone + tablet); the prior behavior silently
// displaced the older client + left it dead-looking. The named error
// surfaces through the join path so the UI can show a clear "name taken"
// message and prompt for a different name.
export class UsernameTakenError extends Error { name = 'UsernameTakenError'; }

export class Room {
  routeContext: RouteContext;
  // Canonical name (lowercased, allowlist-stripped). The Map key, filename,
  // and URL parameter value all use this form.
  roomName: string;
  // Display name (case preserved). Used for UI rendering. Falls back to
  // roomName when undefined (legacy persisted rooms).
  displayName: string;
  // Connected clients. Mutated by Client.handle*Room to add/remove the
  // current connection; broadcast iterates this map. Not for external use
  // outside the Client/Room pair.
  users = new Map<string, Client>();
  filters?: Filter[];
  media: Promise<Map</* mediaId */ string, Media>>;
  userProgress = new Map</* userName */ string, number>();
  ratings = new Map<
    /* mediaId */ string,
    Array<[userName: string, rating: Rate['rating'], time: number]>
  >();

  // Reverse index: userName -> set of mediaIds that user has rated
  // (audit 14 #359). Maintained incrementally in `storeRating`; rebuilt
  // from `ratings` when a room is loaded from disk (`roomStore.ts:
  // loadRoom`). `getMediaForUser` reads this directly instead of
  // walking every rating tuple, turning per-call cost from O(ratings.
  // size) into O(1) lookup + O(media.size) filter. The prior 0.4.2
  // #146 fix already collapsed the inner per-media find() into a Set
  // build; this is the next step (don't even build the Set each call).
  userRated = new Map</* userName */ string, Set</* mediaId */ string>>();

  createdAt: number = Date.now();

  // Timestamp of the most recent rating in this room. Drives the 6h TTL
  // expiry: a room with no swipes for ROOM_TTL_MS gets cleaned up by the
  // periodic sweep in roomStore. Initialized to now so a freshly-created
  // empty room starts the clock from creation -- otherwise a room never
  // swiped in would never expire.
  lastSwipeAt: number = Date.now();

  // Server-side cooldown on applyFilters, shared across every client connected
  // to this room. Belongs here (not on Client) so two browser windows for the
  // same user -- or two different users hammering apply -- can't bypass the
  // cap by being separate WS connections.
  lastApplyAt: number = 0;

  // Deduplication keys for notifyMatch: `${mediaId}:${sortedLikers.join(',')}`.
  // Today each storeRating call produces a unique like-set, so this set is
  // belt-and-suspenders against a future code path (or audit-followup
  // regression) that could call notifyMatch twice for the same like-set.
  //
  // FIFO-capped to NOTIFIED_MATCH_KEYS_CAP entries (audit 11 #190): on a
  // hypothetical max-utilization room (~4000 movies, 10 users) the set
  // could grow to ~40k strings. The 6h TTL keeps real rooms small, but
  // capping is cheap defense in depth.
  private notifiedMatchKeys = new Set<string>();
  private static readonly NOTIFIED_MATCH_KEYS_CAP = 8000;

  constructor(req: CreateRoomRequest, ctx: RouteContext) {
    this.routeContext = ctx;
    this.roomName = req.roomName;
    this.displayName = req.displayName ?? req.roomName;
    this.filters = req.filters;
    this.media = this.fetchMedia();
  }

  private async fetchMedia(filters?: Filter[]): Promise<Map<string, Media>> {
    const [provider] = this.routeContext.providers;
    const sourceMedia = await provider.getMedia({ filters: filters ?? this.filters });

    if (sourceMedia.length === 0) {
      throw new NoMediaError('There are no items with the specified filters applied.');
    }

    // Copy the array before shuffling (audit 13 #280). provider.getMedia()
    // returns a memoized array cached inside the provider (memo1TTL on
    // getMediaCached, 5-min TTL). Shuffling in place mutates that cached
    // array, so two concurrent rooms hitting the same cache slot end up
    // working from partially-shuffled lists -- and each subsequent
    // fetchMedia call sees a list that's *more* shuffled than the last,
    // accumulating bias toward whatever's been swept to the front. The
    // copy is cheap (O(n) reference copies of the array of Media handles,
    // not the Media objects themselves).
    const media = [...sourceMedia];
    // Durstenfeld shuffle -- unbiased O(n) Fisher-Yates variant.
    for (let i = media.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [media[i], media[j]] = [media[j], media[i]];
    }

    return new Map<string, Media>(media.map((m) => [m.id, m]));
  }

  // Monotonic token for applyFilters. Two applies racing (the per-room 3s
  // cooldown makes this rare, but a slow fetchMedia can still overlap) used to
  // be last-RESOLVED-wins; the token makes it last-REQUESTED-wins.
  private applySeq = 0;

  async applyFilters(newFilters: Filter[]): Promise<Media[] | null> {
    // Fetch with new filters before mutating state -- if it throws (e.g. NoMediaError)
    // the room is left intact and this.media remains the previous resolved promise.
    //
    // Ratings + userProgress + matches are preserved across filter changes: a
    // match the room has already found is a piece of shared history, not
    // something a filter change should wipe out. Already-rated media simply
    // won't reappear in the next swipe queue (getMediaForUser filters them).
    const seq = ++this.applySeq;
    const mediaMap = await this.fetchMedia(newFilters);
    // Only commit if no newer applyFilters started while we were fetching --
    // otherwise we'd clobber the newer (last-requested) result with a stale one.
    // Returning null on the losing branch tells the caller not to broadcast
    // a filterChangeApplied for media the room never adopted (the previous
    // code returned the losing media unconditionally, so every client got
    // the stale set even though this.media was on the newer one).
    if (seq !== this.applySeq) {
      return null;
    }
    this.filters = newFilters;
    this.media = Promise.resolve(mediaMap);
    // Applying filters is room activity -- refresh the TTL clock so a room
    // where users actively filter (but haven't swiped) isn't expired.
    this.lastSwipeAt = Date.now();
    return [...mediaMap.values()];
  }

  async getMediaForUser(userName: string): Promise<Media[]> {
    const media = await this.media;
    // O(1) lookup of the user's rated-set via the reverse index (audit
    // 14 #359). The prior implementation walked every rating tuple in
    // the room to build the same set on every call -- fine for small
    // rooms, real cost on the ~4000-movie / few-hundred-rating case.
    // Empty-set fallback for a user who hasn't rated anything yet (no
    // entry in userRated at all).
    const ratedByUser = this.userRated.get(userName) ?? EMPTY_SET;
    return [...media.values()].filter((m) => !ratedByUser.has(m.id));
  }

  // Adds (userName, mediaId) to the reverse index. Called from
  // storeRating's two branches (new rating + adding to existing
  // ratings tuple) so the index stays in sync with `this.ratings`
  // without duplicating the Set construction.
  private recordUserRated(userName: string, mediaId: string): void {
    const existing = this.userRated.get(userName);
    if (existing) {
      existing.add(mediaId);
    } else {
      this.userRated.set(userName, new Set([mediaId]));
    }
  }

  async storeRating(userName: string, rating: Rate, matchedAt: number) {
    // Every accepted rating refreshes the TTL clock.
    this.lastSwipeAt = matchedAt;
    // Snapshot the media map once: this.media is reassignable (applyFilters),
    // so awaiting it twice could observe two different maps mid-operation.
    const media = await this.media;
    const existingRatings = this.ratings.get(rating.mediaId);
    const progress = (this.userProgress.get(userName) ?? 0) + 1;

    if (existingRatings) {
      const alreadyRated = existingRatings.find(([u]) => u === userName);
      if (alreadyRated) {
        logger.warn(`${userName} has already rated ${rating.mediaId}.`);
        return;
      }
      existingRatings.push([userName, rating.rating, matchedAt]);
      this.recordUserRated(userName, rating.mediaId);
      const likes = existingRatings.filter(([, r]) => r === 'like');
      // Only notify when the rating just added is a like: a like is the only
      // thing that can grow the like set. Without the rating.rating guard, a
      // later dislike on an already-matched item re-evaluates likes.length and
      // re-broadcasts the same match. (A 3rd/4th liker still notifies -- the
      // match genuinely gained a member, and that user sees their own match.)
      if (rating.rating === 'like' && likes.length > 1) {
        const matchedMedia = media.get(rating.mediaId);
        if (matchedMedia) {
          const likers = likes.map(([u]) => u);
          // Dedupe by (mediaId, sorted-liker-set) so a re-invocation for the
          // same set can't double-broadcast. Each natural storeRating call
          // produces a unique set today (a like grows the set by one), so
          // this is defense-in-depth rather than a current-behavior fix.
          const matchKey = `${rating.mediaId}:${[...likers].sort().join(',')}`;
          if (!this.notifiedMatchKeys.has(matchKey)) {
            // FIFO cap: drop the oldest key when at the cap so the set
            // can't grow unbounded across a long-lived room. Map/Set
            // iteration order is insertion order in JS, so keys().next()
            // is the oldest entry.
            if (this.notifiedMatchKeys.size >= Room.NOTIFIED_MATCH_KEYS_CAP) {
              const oldest = this.notifiedMatchKeys.values().next().value;
              if (oldest !== undefined) this.notifiedMatchKeys.delete(oldest);
            }
            this.notifiedMatchKeys.add(matchKey);
            this.notifyMatch({ matchedAt, media: matchedMedia, users: likers });
          }
        }
      }
    } else {
      this.ratings.set(rating.mediaId, [[userName, rating.rating, matchedAt]]);
      this.recordUserRated(userName, rating.mediaId);
    }

    this.userProgress.set(userName, progress);
    // safeProgress guards media.size === 0 -- normally non-zero (fetchMedia
    // throws on empty) but defensive against a future empty-media code path
    // producing Infinity / NaN on the wire.
    this.notifyProgress({ userName } as User, safeProgress(progress, media.size));
  }

  async getMatches(userName: string, allLikes: boolean): Promise<Match[]> {
    const matches: Match[] = [];
    // Snapshot once -- not per loop iteration -- so a concurrent applyFilters
    // can't swap this.media out from under the loop.
    const media = await this.media;

    // Single pass over each rating tuple (audit 15 #378). Collects likers,
    // tracks the latest matchedAt, and detects whether userName is among the
    // likers -- previously three traversals (filter + reduce + find).
    for (const [mediaId, rating] of this.ratings.entries()) {
      let matchedAt = 0;
      let userIsLiker = false;
      const likers: string[] = [];
      for (const [u, r, t] of rating) {
        if (r !== 'like') continue;
        likers.push(u);
        if (t > matchedAt) matchedAt = t;
        if (u === userName) userIsLiker = true;
      }
      if (likers.length > 1 && (allLikes || userIsLiker)) {
        const matchedMedia = media.get(mediaId);
        if (matchedMedia) {
          matches.push({ matchedAt, media: matchedMedia, users: likers });
        } else {
          logger.info(`Match references mediaId ${mediaId}, which is not in the current media set.`);
        }
      }
    }

    return matches;
  }

  async getUsers(): Promise<Array<{ user: User; progress: number }>> {
    const media = await this.media;
    return [...this.users.values()].map((client) => {
      const user = client.getUser();
      const raw = this.userProgress.get(user.userName) ?? 0;
      return { user, progress: safeProgress(raw, media.size) };
    });
  }

  notifyJoin(userProgress: UserProgress) {
    this.broadcastMessage(
      { type: 'userJoinedRoom', payload: userProgress },
      userProgress.user.userName,
    );
  }

  notifyLeave(user: User) {
    this.broadcastMessage({ type: 'userLeftRoom', payload: user }, user.userName);
  }

  notifyProgress(user: User, progress: number) {
    this.broadcastMessage({ type: 'userProgress', payload: { user, progress } });
  }

  notifyMatch(match: Match) {
    this.broadcastMessage({ type: 'match', payload: match });
  }

  notifyFilterApplied(appliedBy: string, media: Media[], filters: Filter[]) {
    // Personalized per-user broadcast (audit 16 #433). The raw applyFilters
    // result contains every item in the new media set, but a recipient who
    // has already rated some of them must not get those cards back: the
    // join/rejoin path filters through getMediaForUser, and this broadcast
    // previously didn't -- so any filter apply resurrected every
    // recipient's rated cards as dead swipes (re-rates are silently
    // dropped server-side) until their next rejoin. Filter through the
    // same O(1) userRated index getMediaForUser uses. This message type
    // forgoes broadcastMessage's stringify-once optimization (audit 12
    // #201) deliberately: each user's payload genuinely differs.
    for (const [userName, client] of this.users.entries()) {
      const ratedByUser = this.userRated.get(userName);
      const userMedia = ratedByUser?.size
        ? media.filter((m) => !ratedByUser.has(m.id))
        : media;
      client.sendMessage({
        type: 'filterChangeApplied',
        payload: { appliedBy, media: userMedia, filters },
      });
    }
  }

  broadcastMessage(msg: ClientMessage, sourceUserName?: string) {
    // Stringify once and forward the raw frame to every recipient
    // (audit 12 #201). The prior per-client `sendMessage(msg)` re-ran
    // JSON.stringify for each user -- O(M * payload_size) for a single
    // broadcast. With Media-bearing messages (match, filterChangeApplied)
    // the per-user payload is multi-KB, so the savings compound.
    //
    // Dropped the `if (client && ...)` falsy guard the prior version
    // had (audit 12 #254): Map iteration never yields a falsy value
    // for a present entry, so the check was dead.
    const json = JSON.stringify(msg);
    for (const [userName, client] of this.users.entries()) {
      if (userName !== sourceUserName) {
        client.sendRaw(json);
      }
    }
  }
}

type RoomName = string;
const rooms = new Map<RoomName, Room>();

// Hard cap on concurrently-tracked rooms. A backstop so a flood of createRoom
// calls can't exhaust memory/disk -- far above any legitimate use, since the
// 6h TTL sweep keeps the real in-memory count low.
const MAX_ROOMS = 500;

export const hasRoom = (roomName: string): boolean => rooms.has(roomName);

export const addRoom = (room: Room): void => {
  // The disk-load join path adds rooms here -- enforce the same MAX_ROOMS cap
  // createRoom does, or a directory of persisted rooms could load past it and
  // defeat the memory-exhaustion backstop. Overwriting an existing key is not
  // a new room, so it isn't capped.
  if (!rooms.has(room.roomName) && rooms.size >= MAX_ROOMS) {
    throw new RoomLimitError(`Room limit reached (${MAX_ROOMS}). Try again later.`);
  }
  rooms.set(room.roomName, room);
};

// Snapshot iteration of all in-memory rooms. Returns an array (not the
// live iterator) so callers can safely call removeRoom() while iterating.
export const getAllRooms = (): Room[] => [...rooms.values()];

// MEMORY-ONLY removal -- does NOT unlink the persisted JSON file. Callers
// that want the room gone for good must also unlink `roomFilePath(name)`
// themselves (or call the higher-level cleanup path in roomStore which
// bundles both). Today only `cleanupExpiredRooms` calls this, and it
// performs the unlink explicitly. Audit 12 #203 flagged that any future
// caller of `removeRoom` alone would leak the on-disk file -- which then
// resurrects the room on the next startup via `loadRoom`.
export const removeRoom = (roomName: string): boolean => rooms.delete(roomName);

export const createRoom = async (
  createRequest: CreateRoomRequest,
  ctx: RouteContext,
): Promise<Room> => {
  if (rooms.has(createRequest.roomName)) {
    throw new RoomExistsError(`${createRequest.roomName} already exists.`);
  }
  if (rooms.size >= MAX_ROOMS) {
    throw new RoomLimitError(`Room limit reached (${MAX_ROOMS}). Try again later.`);
  }
  const room = new Room(createRequest, ctx);
  await room.media;
  // Re-check after the await: two concurrent createRoom calls for the same
  // name can both pass the initial has() check (each yields on room.media
  // before setting). Without this guard the later writer silently overwrites
  // the earlier room's Map entry and the earlier client ends up orphaned.
  if (rooms.has(room.roomName)) {
    throw new RoomExistsError(`${createRequest.roomName} already exists.`);
  }
  rooms.set(room.roomName, room);
  return room;
};

// Accepts a bare roomName -- audit 12 #256: the prior `JoinRoomRequest`
// parameter type made every caller pass a full request object even though
// only `.roomName` was read. The callers in client.ts pass the sanitized
// canonical name; nothing needed the surrounding object shape.
export const getRoom = (roomName: string): Room => {
  const room = rooms.get(roomName);
  if (!room) throw new RoomNotFoundError(`The room "${roomName}" does not exist.`);

  // The same user rejoining (e.g. after a page refresh) is handled by the
  // caller: joinRoomFromSanitized probes a colliding entry's socket liveness
  // and displaces a dead holder (a stale WS entry can outlive the TCP close),
  // while a demonstrably live holder rejects the join with
  // UsernameTakenError (0.5.22 + audit 16 #421). handleLeaveRoom guards its
  // delete by identity so a displaced WS's close won't evict the new one.
  return room;
};
