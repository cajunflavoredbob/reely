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

// Shared fallback for the userRated index: avoids allocating a Set per
// getMediaForUser call for users who haven't rated. Frozen so nobody mutates
// the shared instance.
const EMPTY_SET: ReadonlySet<string> = Object.freeze(new Set<string>());

// Progress fraction, safe on both ends. 0 when total <= 0, so an empty-media
// room can't put Infinity / NaN on the wire. Still clamped to 1 even though
// applyFilters now rebases the counters: loadRoom restores a persisted count
// against a media set refetched from a library that may have shrunk since, so
// count > total survives that path. Unclamped, 51/40 reaches the wire,
// persists, and renders "128%".
export const safeProgress = (count: number, total: number): number =>
  total > 0 ? Math.min(1, count / total) : 0;

export class RoomExistsError extends Error { name = 'RoomExistsError'; }
export class RoomLimitError extends Error { name = 'RoomLimitError'; }
export class RoomNotFoundError extends Error { name = 'RoomNotFoundError'; }
export class NoMediaError extends Error { name = 'NoMediaError'; }
// A username already held by a DIFFERENT live connection in the same room.
// Named so the join path can prompt for a different name rather than silently
// displacing the older client and leaving it dead-looking.
export class UsernameTakenError extends Error { name = 'UsernameTakenError'; }

export class Room {
  routeContext: RouteContext;
  // Canonical name (lowercased, allowlist-stripped). The Map key, filename,
  // and URL parameter value all use this form.
  roomName: string;
  // Display name (case preserved). Falls back to roomName for legacy rooms.
  displayName: string;
  // Connected clients. Owned by the Client/Room pair; nothing else mutates it.
  users = new Map<string, Client>();
  filters?: Filter[];
  media: Promise<Map</* mediaId */ string, Media>>;
  userProgress = new Map</* userName */ string, number>();
  ratings = new Map<
    /* mediaId */ string,
    Array<[userName: string, rating: Rate['rating'], time: number]>
  >();

  // Reverse index: userName -> mediaIds rated. Maintained in storeRating,
  // rebuilt from `ratings` by roomStore's loadRoom. Turns getMediaForUser from
  // O(ratings.size) into an O(1) lookup.
  userRated = new Map</* userName */ string, Set</* mediaId */ string>>();

  createdAt: number = Date.now();

  // Most recent rating; drives the 6h TTL sweep in roomStore. Initialized to
  // now so a room nobody ever swipes in still expires.
  lastSwipeAt: number = Date.now();

  // applyFilters cooldown. On the room, not the Client, so two browser windows
  // can't bypass it by being separate connections.
  lastApplyAt: number = 0;

  // Media for already-matched items, so a later filter change can't make an
  // existing match unrenderable: applyFilters keeps `ratings` while narrowing
  // `media`, and getMatches resolves through the current media map, so without
  // this a filtered-out match vanishes from the UI on the next rejoin.
  //
  // In-memory only: persisting the Media objects would need a room-file schema
  // change, so a filtered-out match still drops on restart.
  matchedMedia = new Map</* mediaId */ string, Media>();

  // notifyMatch dedupe keys: `${mediaId}:${sortedLikers.join(',')}`. Each
  // storeRating produces a unique like-set today, so this guards a future path
  // that double-notifies. FIFO-capped because a max-utilization room (~4000
  // movies, 10 users) could reach ~40k strings.
  private notifiedMatchKeys = new Set<string>();
  private static readonly NOTIFIED_MATCH_KEYS_CAP = 8000;

  // FIFO cap for matchedMedia: it holds full Media objects, so capping the
  // cheap key set above and not this one would be backwards. Only filtered-out
  // titles retain bytes; the rest share references with room.media.
  private static readonly MATCHED_MEDIA_CAP = 2000;

  // Cap on distinct identities a room will ever track. userProgress, ratings
  // and userRated are keyed on a self-asserted userName with no eviction, and
  // login deliberately preserves a renamed user's progress, so one socket that
  // logs in under a fresh name before each swipe grows all three (and the room
  // file on disk) without bound. The two caps above bound the cheap maps; this
  // bounds the expensive ones. Real rooms are limited by the WS connection
  // count and never come near it.
  private static readonly MAX_ROOM_IDENTITIES = 500;

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

    // Copy before shuffling: provider.getMedia() returns an array memoized
    // inside the provider (5-min TTL), so an in-place shuffle mutates the
    // shared cache and each fetchMedia accumulates bias from the last.
    const media = [...sourceMedia];
    // Durstenfeld shuffle: unbiased O(n) Fisher-Yates variant.
    for (let i = media.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [media[i], media[j]] = [media[j], media[i]];
    }

    return new Map<string, Media>(media.map((m) => [m.id, m]));
  }

  // Makes racing applies last-REQUESTED-wins instead of last-RESOLVED-wins; a
  // slow fetchMedia can overlap despite the 3s cooldown.
  private applySeq = 0;

  async applyFilters(newFilters: Filter[]): Promise<Media[] | null> {
    // Fetch before mutating state: a throw (NoMediaError) must leave the room
    // intact. Ratings, userProgress and matches survive filter changes;
    // already-rated media just won't reappear in the swipe queue.
    const seq = ++this.applySeq;
    let mediaMap: Map<string, Media>;
    try {
      mediaMap = await this.fetchMedia(newFilters);
    } catch (err) {
      // Give the number back if we are still the newest apply. An apply that
      // commits nothing (NoMediaError) must not supersede one already parked on
      // its Plex fetch: that one would return null and, since the caller treats
      // null as "say nothing", its user would get no deck change and no error
      // at all. The guard matters because a THIRD apply may have started while
      // we were fetching, and it owns the sequence now.
      if (this.applySeq === seq) this.applySeq = seq - 1;
      throw err;
    }
    // Commit only if no newer apply started mid-fetch. null tells the caller
    // not to broadcast filterChangeApplied for media the room never adopted.
    if (seq !== this.applySeq) {
      return null;
    }
    // Archive matches the NEW set can't serve, before swapping it in.
    // Archiving at match-formation time instead spends the FIFO budget on
    // titles room.media still resolves, evicting exactly the entries the
    // archive exists for.
    const previousMedia = await this.media;
    for (const [mediaId, rating] of this.ratings.entries()) {
      if (mediaMap.has(mediaId)) continue;
      if (rating.filter(([, r]) => r === 'like').length < 2) continue;
      const media = previousMedia.get(mediaId) ?? this.matchedMedia.get(mediaId);
      if (media) this.archiveMatchedMedia(mediaId, media);
    }
    this.filters = newFilters;
    this.media = Promise.resolve(mediaMap);
    this.rebaseProgress(mediaMap);
    // Filtering is activity: refresh the TTL so an actively-filtered room lives.
    this.lastSwipeAt = Date.now();
    return [...mediaMap.values()];
  }

  /**
   * Re-derive every userProgress counter against a freshly installed media map.
   *
   * userProgress is a free-running count of ratings, but the denominator is the
   * CURRENT media set. Narrow the set and the counter outgrows it: swipe 200
   * cards, then filter down to 50, and safeProgress clamps 200/50 to a full
   * ring for the rest of the session while getMediaForUser is still handing out
   * unrated cards. The only honest numerator is the user's rated ids that the
   * new set still contains, which is exactly what getMediaForUser subtracts.
   */
  private rebaseProgress(mediaMap: Map<string, Media>) {
    for (const [userName, previous] of this.userProgress.entries()) {
      let rebased = 0;
      const rated = this.userRated.get(userName);
      if (rated) {
        for (const mediaId of rated) {
          if (mediaMap.has(mediaId)) rebased += 1;
        }
      }
      if (rebased === previous) continue;
      this.userProgress.set(userName, rebased);
      // Only connected users have a ring on screen, and filterChangeApplied
      // carries no progress, so without this their rings stay on the old value
      // until their next swipe.
      if (this.users.has(userName)) {
        this.notifyProgress({ userName } as User, safeProgress(rebased, mediaMap.size));
      }
    }
  }

  async getMediaForUser(userName: string): Promise<Media[]> {
    const media = await this.media;
    // O(1) rated-set lookup via the reverse index.
    const ratedByUser = this.userRated.get(userName) ?? EMPTY_SET;
    return [...media.values()].filter((m) => !ratedByUser.has(m.id));
  }

  // Keeps userRated in sync with `ratings`; called from both storeRating
  // branches.
  private recordUserRated(userName: string, mediaId: string): void {
    const existing = this.userRated.get(userName);
    if (existing) {
      existing.add(mediaId);
    } else {
      this.userRated.set(userName, new Set([mediaId]));
    }
  }

  // INVARIANT: a Room must never be published to a Client while `room.media` is
  // still pending. createRoom and loadRoom await it; applyFilters installs an
  // already-resolved promise. Otherwise a rate racing a filter change writes a
  // match that is never notified, never archived, and unresolvable later.
  async storeRating(userName: string, rating: Rate, matchedAt: number) {
    // Refuse before touching the TTL clock, or the flood that filled the room
    // would also keep it alive to be refilled.
    if (
      !this.userProgress.has(userName) &&
      this.userProgress.size >= Room.MAX_ROOM_IDENTITIES
    ) {
      logger.warn(
        `Room "${this.roomName}" is tracking ${this.userProgress.size} identities; ignoring rating from ${userName}.`,
      );
      return;
    }
    // Every accepted rating refreshes the TTL clock.
    this.lastSwipeAt = matchedAt;
    // Snapshot once: applyFilters reassigns this.media, so awaiting it twice
    // could observe two different maps mid-operation.
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
      // Only a like can grow the like set. Without this guard a later dislike
      // on an already-matched item re-broadcasts the same match. A 3rd liker
      // still notifies: the match genuinely gained a member.
      if (rating.rating === 'like' && likes.length > 1) {
        const matchedMedia = media.get(rating.mediaId);
        if (matchedMedia) {
          const likers = likes.map(([u]) => u);
          // Dedupe by (mediaId, sorted likers) so a re-invocation for the same
          // set can't double-broadcast.
          const matchKey = `${rating.mediaId}:${[...likers].sort().join(',')}`;
          if (!this.notifiedMatchKeys.has(matchKey)) {
            // FIFO: Set iteration is insertion order, so values().next() is
            // the oldest key.
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
    // safeProgress guards media.size === 0 (Infinity / NaN on the wire).
    this.notifyProgress({ userName } as User, safeProgress(progress, media.size));
  }

  async getMatches(userName: string, allLikes: boolean): Promise<Match[]> {
    const matches: Match[] = [];
    // Snapshot once so a concurrent applyFilters can't swap it mid-loop.
    const media = await this.media;
    // Collected and logged once at debug. Per-match at info re-emitted the same
    // lines on every join and every reconnect-driven rejoin, for every device,
    // for the life of the room, against a container that ships no log rotation.
    const unresolved: string[] = [];

    // One pass per rating tuple: likers, latest matchedAt, and whether userName
    // liked it.
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
        // Archive as fallback: a match stays visible once a filter excludes it.
        const matchedMedia = media.get(mediaId) ?? this.matchedMedia.get(mediaId);
        if (matchedMedia) {
          matches.push({ matchedAt, media: matchedMedia, users: likers });
        } else {
          unresolved.push(mediaId);
        }
      }
    }

    if (unresolved.length > 0) {
      logger.debug(
        `${unresolved.length} match(es) reference media missing from the current set: ${unresolved.join(', ')}`,
      );
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

  /** Archive a matched title's media, evicting the oldest entry past the cap. */
  private archiveMatchedMedia(mediaId: string, media: Media) {
    if (this.matchedMedia.has(mediaId)) return;
    if (this.matchedMedia.size >= Room.MATCHED_MEDIA_CAP) {
      const oldest = this.matchedMedia.keys().next().value;
      if (oldest !== undefined) this.matchedMedia.delete(oldest);
    }
    this.matchedMedia.set(mediaId, media);
  }

  notifyMatch(match: Match) {
    // Likers only, so the live stream agrees with the rejoin snapshot from
    // getMatches(userName, false). Unfiltered, a non-liker gets the celebration
    // and then loses the entry on the next WS blip, and the seen-match id
    // survives rejoin so it never re-celebrates if they later like it.
    const likers = new Set(match.users);
    for (const [userName, client] of this.users.entries()) {
      if (likers.has(userName)) client.sendMessage({ type: 'match', payload: match });
    }
  }

  notifyFilterApplied(appliedBy: string, media: Media[], filters: Filter[]) {
    // Per-user payload: the raw applyFilters result holds every item in the new
    // set, so without the userRated filter an apply resurrects each recipient's
    // rated cards as dead swipes (re-rates are dropped server-side). Skips
    // broadcastMessage's stringify-once path deliberately: every payload
    // differs.
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
    // Stringify once and forward the raw frame: re-encoding per client is
    // O(M * payload_size), and Media-bearing messages are multi-KB each.
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

// Backstop so a createRoom flood can't exhaust memory/disk. Far above real use;
// the 6h TTL sweep keeps the live count low.
const MAX_ROOMS = 500;

export const hasRoom = (roomName: string): boolean => rooms.has(roomName);

export const addRoom = (room: Room): void => {
  // The disk-load join path comes through here, so it needs createRoom's cap or
  // a directory of persisted rooms loads past it. Overwriting an existing key
  // isn't a new room.
  if (!rooms.has(room.roomName) && rooms.size >= MAX_ROOMS) {
    throw new RoomLimitError(`Room limit reached (${MAX_ROOMS}). Try again later.`);
  }
  rooms.set(room.roomName, room);
};

// An array, not the live iterator, so callers can removeRoom() while iterating.
export const getAllRooms = (): Room[] => [...rooms.values()];

// MEMORY-ONLY: does NOT unlink the persisted JSON. Callers must unlink
// roomFilePath(name) themselves, or the file leaks and loadRoom resurrects the
// room on the next startup.
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
  // Two concurrent creates both pass the initial has() check (each yields on
  // room.media), and the later writer would orphan the earlier room's client.
  if (rooms.has(room.roomName)) {
    throw new RoomExistsError(`${createRequest.roomName} already exists.`);
  }
  // The size check above is just as stale as the has() check: N creates fired
  // while the registry sat one slot under the cap all parked on the Plex fetch,
  // all passed it, and all commit. MAX_ROOMS is the only backstop against a
  // create flood, so it has to hold at commit time, not just at request time.
  if (rooms.size >= MAX_ROOMS) {
    throw new RoomLimitError(`Room limit reached (${MAX_ROOMS}). Try again later.`);
  }
  rooms.set(room.roomName, room);
  return room;
};

/**
 * True when `room` is still the instance registered under its name.
 *
 * Identity, not presence: after an await the name can hold a DIFFERENT Room
 * (the TTL sweep collects one while a joiner is parked, a later joiner rebuilds
 * it), leaving the first joiner on an orphan whose saves overwrite the live
 * room's file and which no sweep can reach.
 */
export const isRegisteredRoom = (room: Room): boolean => rooms.get(room.roomName) === room;

export const getRoom = (roomName: string): Room => {
  const room = rooms.get(roomName);
  if (!room) throw new RoomNotFoundError(`The room "${roomName}" does not exist.`);

  // Username collisions are the caller's job: joinRoomFromSanitized probes the
  // holder's socket, displaces a dead one, and rejects a live one with
  // UsernameTakenError.
  return room;
};
