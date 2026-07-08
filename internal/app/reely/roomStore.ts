import { join, resolve, sep } from 'node:path';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { CreateRoomRequest, Filter } from '../../../types/reely';
import { logger } from './logger';
import { Room, getAllRooms, removeRoom, hasRoom } from './room';
import type { RouteContext } from './types';

const ROOMS_DIR = join(process.cwd(), 'data', 'rooms');

// Active-room TTL. A room with no swipe activity for this duration is cleaned
// up by the periodic sweep in app.ts. Matches the Login footer copy
// ("rooms expire 6h after last swipe").
export const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

interface PersistedRoom {
  roomName: string;
  // Optional for backward-compat with rooms persisted before 0.2.19.
  // Loading falls back to roomName as the display when absent.
  displayName?: string;
  filters?: Filter[];
  ratings: Array<[string, Array<[string, string, number]>]>;
  userProgress: Array<[string, number]>;
  createdAt: number;
  updatedAt: number;
  // Optional for backward-compat with rooms persisted before 0.2.20.
  // Loading falls back to updatedAt -- close enough for TTL purposes.
  lastSwipeAt?: number;
}

// Defense-in-depth: assert the resolved path stays under ROOMS_DIR
// (audit 12 #230). `sanitizeRoomNameCanonical` already strips path
// separators / `..` / control bytes upstream, so a malicious name
// shouldn't reach here -- this is a backstop against a future
// sanitization regression. The resolved-path check catches both
// absolute paths (`/etc/passwd`) and traversal attempts that survive
// somehow (`../etc/passwd`).
const ROOMS_DIR_RESOLVED = resolve(ROOMS_DIR);
const roomFilePath = (roomName: string) => {
  const candidate = join(ROOMS_DIR, `${roomName}.json`);
  const resolved = resolve(candidate);
  if (resolved !== candidate || !resolved.startsWith(ROOMS_DIR_RESOLVED + sep)) {
    throw new Error(`Refusing to use room file path outside ${ROOMS_DIR}: ${roomName}`);
  }
  return candidate;
};

// Per-field shape check for a PersistedRoom value loaded from disk
// (audit 12 #205, extending the partial check added in 0.4.1 #90). Returns
// true when every required field type-matches AND every optional field
// is either absent or its declared type. The function logs the offending
// field name to make a hand-edit operator's life easier.
const isPersistedRoomShape = (
  parsed: unknown,
  roomName: string,
): parsed is PersistedRoom => {
  const fail = (reason: string): false => {
    logger.error(`Room file "${roomName}" has an invalid shape: ${reason}; ignoring it.`);
    return false;
  };
  if (!parsed || typeof parsed !== 'object') return fail('not an object');
  const r = parsed as Partial<PersistedRoom>;
  if (typeof r.roomName !== 'string') return fail('roomName must be a string');
  if (r.displayName !== undefined && typeof r.displayName !== 'string') {
    return fail('displayName must be a string when present');
  }
  if (r.filters !== undefined && !Array.isArray(r.filters)) {
    return fail('filters must be an array when present');
  }
  if (!Array.isArray(r.ratings)) return fail('ratings must be an array');
  if (!Array.isArray(r.userProgress)) return fail('userProgress must be an array');
  if (typeof r.createdAt !== 'number') return fail('createdAt must be a number');
  if (typeof r.updatedAt !== 'number') return fail('updatedAt must be a number');
  if (r.lastSwipeAt !== undefined && typeof r.lastSwipeAt !== 'number') {
    return fail('lastSwipeAt must be a number when present');
  }
  return true;
};

export const saveRoom = async (room: Room): Promise<void> => {
  try {
    await mkdir(ROOMS_DIR, { recursive: true });
    const data: PersistedRoom = {
      roomName: room.roomName,
      displayName: room.displayName,
      filters: room.filters,
      ratings: [...room.ratings.entries()],
      userProgress: [...room.userProgress.entries()],
      createdAt: room.createdAt,
      updatedAt: Date.now(),
      lastSwipeAt: room.lastSwipeAt,
    };
    const target = roomFilePath(room.roomName);
    // Include pid + random bytes so concurrent saveRoom() calls for the same
    // room don't write to the same tmp path and race on rename. Last-write-wins
    // is the previous behavior but two writes could otherwise stomp each other
    // mid-flight and lose data.
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf-8');
    await rename(tmp, target);
  } catch (err) {
    logger.error(`Failed to save room "${room.roomName}": ${String(err)}`);
  }
};

// Debounced room save. Ratings mutate the in-memory Room but used to be
// persisted only on create/join/filter/disconnect, so a crash between swipes
// and disconnect lost recent ratings/matches. handleRate calls this after
// every rating; bursts of swipes coalesce into one write SAVE_DEBOUNCE_MS
// after activity settles (per room, so multiple raters in one room share the
// write). A crash loses at most that window of swipes -- an accepted tradeoff
// against a disk write per swipe.
const SAVE_DEBOUNCE_MS = 2000;

// Store the Room alongside the timer so cancel + flush can access the live
// Room without re-resolving it through getAllRooms() (the room may have
// been removed by the time flush runs).
interface PendingSave {
  timer: ReturnType<typeof setTimeout>;
  room: Room;
}
const pendingSaves = new Map<string, PendingSave>();

export const scheduleSaveRoom = (room: Room): void => {
  const existing = pendingSaves.get(room.roomName);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingSaves.delete(room.roomName);
    void saveRoom(room);
  }, SAVE_DEBOUNCE_MS);
  pendingSaves.set(room.roomName, { timer, room });
};

// Drop any queued save for `roomName` without writing. Used by
// cleanupExpiredRooms to prevent a debounced save from resurrecting a JSON
// file the sweep just unlinked.
export const cancelPendingSave = (roomName: string): void => {
  const entry = pendingSaves.get(roomName);
  if (entry) {
    clearTimeout(entry.timer);
    pendingSaves.delete(roomName);
  }
};

// Flush every queued save NOW and clear the map. Called from app shutdown
// so the 2s debounce window can't lose a swipe that landed just before
// SIGTERM, and so the timers don't fire after the process is in exit.
//
// Rejection reasons aren't surfaced here (audit 12 #257) -- saveRoom
// catches its own errors and logs each via the redacting logger. Using
// `Promise.allSettled` so a single failed save doesn't short-circuit
// the rest of the queue; failed saves stay logged at the saveRoom layer.
export const flushPendingSaves = async (): Promise<void> => {
  const pending = [...pendingSaves.values()];
  pendingSaves.clear();
  for (const { timer } of pending) clearTimeout(timer);
  await Promise.allSettled(pending.map(({ room }) => saveRoom(room)));
};

export const loadRoom = async (roomName: string, ctx: RouteContext): Promise<Room | null> => {
  try {
    const raw = await readFile(roomFilePath(roomName), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    // JSON.parse only guarantees valid JSON, not the PersistedRoom shape.
    // Per-field shape check matches the validator's thoroughness (audit
    // 12 #205): every required PersistedRoom field gets a type check, and
    // every optional field is allowed to be undefined or its declared
    // type. A truncated or hand-edited file is rejected as soon as a
    // mismatch is found, rather than fed half-undefined into a Room.
    if (!isPersistedRoomShape(parsed, roomName)) return null;
    const data = parsed;
    const req: CreateRoomRequest = {
      // Use the requested name (= the filename), not the file's own
      // `data.roomName`. The filename is the canonical identity (it's the
      // Map key and URL param); a file whose in-body roomName disagrees with
      // its filename must not load under the body's name.
      roomName,
      displayName: data.displayName ?? roomName,
      filters: data.filters,
    };
    const room = new Room(req, ctx);
    await room.media;
    // Per-entry shape validation -- the outer Array.isArray check above only
    // proves the field IS an array. A malformed entry inside (a truncated
    // tuple, a wrong rating literal, a non-numeric timestamp) used to be
    // accepted via an unchecked cast, producing a Map with corrupt values
    // and no error surfaced. Reject the whole file on any malformed entry.
    type RatingTuple = [user: string, rating: 'like' | 'dislike', time: number];
    type RatingsEntry = [mediaId: string, tuples: RatingTuple[]];
    const isRatingTuple = (t: unknown): t is RatingTuple =>
      Array.isArray(t) && t.length === 3 &&
      typeof t[0] === 'string' &&
      (t[1] === 'like' || t[1] === 'dislike') &&
      typeof t[2] === 'number';
    const isRatingsEntry = (e: unknown): e is RatingsEntry =>
      Array.isArray(e) && e.length === 2 &&
      typeof e[0] === 'string' &&
      Array.isArray(e[1]) && e[1].every(isRatingTuple);
    if (!data.ratings.every(isRatingsEntry)) {
      logger.error(`Room file "${roomName}" has malformed ratings; ignoring it.`);
      return null;
    }
    room.ratings = new Map(data.ratings);
    // Rebuild the reverse index (audit 14 #359). storeRating maintains
    // it incrementally; loadRoom restores from persistent state so
    // every (userName, mediaId) pair has to be re-recorded here.
    room.userRated = new Map<string, Set<string>>();
    for (const [mediaId, ratingTuples] of room.ratings) {
      for (const [userName] of ratingTuples) {
        const existing = room.userRated.get(userName);
        if (existing) {
          existing.add(mediaId);
        } else {
          room.userRated.set(userName, new Set([mediaId]));
        }
      }
    }
    room.userProgress = new Map(data.userProgress);
    room.createdAt = data.createdAt;
    room.lastSwipeAt = data.lastSwipeAt ?? data.updatedAt;
    logger.info(`Restored room "${roomName}" from disk.`);
    return room;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // The room file exists but couldn't be restored. Most commonly the
      // provider refetch (Room.fetchMedia) failed because Plex is down or
      // the saved filter set no longer matches any media. The room file
      // stays on disk for the next attempt (no auto-delete). Log loudly
      // so an operator restarting after a Plex outage can correlate
      // "room X didn't restore" with "Plex was down at boot" (audit 12
      // #228 -- the prior log read like a generic load failure).
      logger.error(
        `Failed to restore room "${roomName}" from disk (file kept; ` +
          `most likely the provider refetch failed): ${String(err)}`,
      );
    }
    return null;
  }
};

// Sweep both the in-memory registry and persisted room files, removing any
// whose lastSwipeAt is older than now - ttlMs. Runs at startup and on a
// periodic interval scheduled by app.ts. This is the only room-expiry policy:
// the old 90-day cold-storage cleanup was removed because the 6h TTL always
// preempted it (nothing ever survived to 90 days).
//
// A room with clients still connected is never expired -- evicting it would
// orphan those clients' Room references and let a fresh join build a second,
// divergent Room under the same name (split-brain).
export const cleanupExpiredRooms = async (ttlMs: number = ROOM_TTL_MS): Promise<void> => {
  const now = Date.now();
  const cutoff = now - ttlMs;

  // In-memory pass: getAllRooms() returns a snapshot so we can mutate the
  // registry while iterating.
  for (const room of getAllRooms()) {
    if (room.users.size > 0) continue; // in active use -- keep it
    if (room.lastSwipeAt < cutoff) {
      // Cancel any queued debounced save FIRST. Without this, a save timer
      // scheduled within the last 2s would fire after the unlink below and
      // recreate the JSON file the sweep just deleted.
      cancelPendingSave(room.roomName);
      // Unlink BEFORE removeRoom (audit 12 #231): swapped from the prior
      // remove-then-unlink order to close the cleanup-vs-create race. In
      // the old order, between `removeRoom` and `unlink` a concurrent
      // `createRoom("foo")` could pass the `hasRoom` check, write the
      // fresh file via `saveRoom`, and then the cleanup's `unlink` would
      // delete the just-written file -- leaving an orphaned in-memory
      // room with no disk presence. With unlink-first, any concurrent
      // createRoom sees the room still in the map and gets
      // RoomExistsError; the user retries after the removeRoom completes.
      const filePath = roomFilePath(room.roomName);
      // Surface non-ENOENT unlink failures (audit 13 #290). EACCES /
      // EBUSY / EISDIR on the room file are real operational problems
      // (permissions or a host bind-mount gone weird) that should
      // appear in the log, not stay silent. ENOENT is benign here:
      // the file might already be gone from a previous sweep race.
      await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') {
          logger.error(
            `Failed to unlink expired room file ${filePath}: ${err.message}`,
          );
        }
      });
      // Re-check occupancy after the unlink await (audit 16 #424): a queued
      // joinRoom can run to its users.set() synchronously during the I/O
      // wait -- hasRoom is still true, so it takes the in-memory branch and
      // never notices the sweep. Removing the now-occupied room would orphan
      // that client's Room reference and invite the split-brain documented
      // above. Skip removal and re-persist to restore the just-unlinked file.
      if (room.users.size > 0) {
        await saveRoom(room);
        logger.info(
          `TTL sweep skipped "${room.roomName}": a client joined during cleanup`,
        );
        continue;
      }
      removeRoom(room.roomName);
      logger.info(
        `Expired room "${room.roomName}" (idle ${Math.round((now - room.lastSwipeAt) / 60000)}m, ttl ${ttlMs}ms)`,
      );
    }
  }

  // Disk pass: catch rooms that were persisted before this process started
  // (or saved + abandoned) and never loaded into memory.
  try {
    await mkdir(ROOMS_DIR, { recursive: true });
    const files = await readdir(ROOMS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      // Rooms currently in memory are the in-memory pass's responsibility
      // (which skips live ones) -- don't let the disk pass delete a live
      // room's file. The filename without .json is the canonical room name.
      if (hasRoom(file.slice(0, -'.json'.length))) continue;
      const filePath = join(ROOMS_DIR, file);
      try {
        const raw = await readFile(filePath, 'utf-8');
        // The disk-sweep path used to do `JSON.parse(raw) as PersistedRoom`
        // and then read `data.lastSwipeAt ?? data.updatedAt` directly. A
        // file containing a non-object JSON literal (e.g. `42`, `"foo"`,
        // `null`) parses successfully, but the property access then
        // throws a TypeError that lands in the catch below as a
        // "removed unreadable room file" log. The behavior was correct
        // (the file gets cleaned up) but the path through TypeError
        // was implicit. Audit 13 #289 / audit 14 same-site asked for
        // an explicit `typeof data === 'object'` guard so the
        // non-object case is handled as data, not as an exception.
        // The full isPersistedRoomShape check (load path) is heavier
        // than this disk-sweep needs; the sweep only reads two
        // timestamp fields, so a shallow object check is enough.
        const parsed: unknown = JSON.parse(raw);
        const data = (parsed && typeof parsed === 'object')
          ? (parsed as PersistedRoom)
          : ({} as PersistedRoom);
        const effectiveLastSwipe = data.lastSwipeAt ?? data.updatedAt;
        // Treat a file with no usable timestamp as ancient and sweep it.
        // Prior code did `effectiveLastSwipe < cutoff` which is `false`
        // for `undefined`, so a malformed/legacy file with neither
        // `lastSwipeAt` nor `updatedAt` would never sweep -- a slow leak
        // of orphaned room files across restarts (audit 12 #204).
        if (effectiveLastSwipe === undefined || effectiveLastSwipe < cutoff) {
          await unlink(filePath);
          logger.info(
            `Expired room file ${filePath}` +
              (effectiveLastSwipe === undefined ? ' (no timestamp -- treated as ancient)' : ''),
          );
        }
      } catch (err) {
        // Unreadable or corrupt room file -- remove it so it can't accumulate.
        await unlink(filePath).catch(() => {});
        // Log the full filePath, not just the basename: when an operator
        // shells into the container to look at the file, the path is what
        // matters for grep / ls.
        logger.warn(
          `Removed unreadable room file ${filePath}: ${(err as Error).message}`,
        );
      }
    }
  } catch (err) {
    logger.error(`TTL sweep dir scan failed: ${String(err)}`);
  }
};

