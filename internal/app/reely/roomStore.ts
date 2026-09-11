import { join, resolve, sep } from 'node:path';
import { mkdir, readFile, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { CreateRoomRequest, Filter } from '../../../types/reely';
import { logger } from './logger';
import { isValidFilter } from './util/filters';
import { Room, getAllRooms, removeRoom, hasRoom } from './room';
import type { RouteContext } from './types';

const ROOMS_DIR = join(process.cwd(), 'data', 'rooms');

// Active-room TTL. app.ts sweeps rooms idle this long; Login footer promises 6h.
export const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

interface PersistedRoom {
  roomName: string;
  // Absent in old files; loading falls back to roomName.
  displayName?: string;
  filters?: Filter[];
  ratings: Array<[string, Array<[string, string, number]>]>;
  userProgress: Array<[string, number]>;
  createdAt: number;
  updatedAt: number;
  // Absent in old files; loading falls back to updatedAt.
  lastSwipeAt?: number;
}

// Backstop if name sanitization regresses: the resolved path must stay under
// ROOMS_DIR, catching absolute paths and surviving `..` traversal.
const ROOMS_DIR_RESOLVED = resolve(ROOMS_DIR);
const roomFilePath = (roomName: string) => {
  const candidate = join(ROOMS_DIR, `${roomName}.json`);
  const resolved = resolve(candidate);
  if (resolved !== candidate || !resolved.startsWith(ROOMS_DIR_RESOLVED + sep)) {
    throw new Error(`Refusing to use room file path outside ${ROOMS_DIR}: ${roomName}`);
  }
  return candidate;
};

// Shape-check a disk-loaded PersistedRoom; logs which field is wrong.
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

/**
 * Keep a persisted room's filters only if every entry is valid.
 *
 * Drop the filters, never the file: rejecting the file makes join treat the
 * room as nonexistent and the next save overwrite every rating and match.
 * All-or-nothing, and `library` is a filter key, so a library-scoped room
 * serves the whole server until someone re-scopes it.
 */
const sanitizeLoadedFilters = (
  roomName: string,
  filters: Filter[] | undefined,
): Filter[] | undefined => {
  if (filters === undefined || filters.every(isValidFilter)) return filters;
  logger.error(
    `Room file "${roomName}" has an invalid filter; loading the room without filters.`,
  );
  return undefined;
};

// A bind-mounted data dir whose host directory is not owned by the container
// user fails every save while the app keeps serving from memory and /health
// keeps returning 200, so the log line is the only signal an operator gets:
// make it name the cause instead of printing a bare errno.
const describeSaveFailure = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'EACCES' && code !== 'EPERM') return String(err);
  const uid = process.getuid?.();
  return (
    `${String(err)} (${ROOMS_DIR} is not writable by uid ` +
    `${uid === undefined ? 'unknown' : uid}; rooms will not survive a restart)`
  );
};

const writeRoomFile = async (roomName: string, data: PersistedRoom): Promise<void> => {
  let tmp: string | undefined;
  try {
    await mkdir(ROOMS_DIR, { recursive: true });
    const target = roomFilePath(roomName);
    // pid + random bytes: a save of this room in another process sharing the
    // data volume must not share a tmp path.
    tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf-8');
    await rename(tmp, target);
  } catch (err) {
    logger.error(`Failed to save room "${roomName}": ${describeSaveFailure(err)}`);
    // An ordinary ENOSPC/EIO strands the tmp file, and the TTL sweep only
    // reaps by age, so clear it here while the path is still known.
    if (tmp) await unlink(tmp).catch(() => {});
  }
};

// One write chain per room. Two overlapping saves rename onto the same target
// and the last rename wins, which is not the same as the newest snapshot
// winning; chaining makes commit order match snapshot order.
const saveChains = new Map<string, Promise<void>>();

export const saveRoom = (room: Room): Promise<void> => {
  // Snapshot synchronously. Taken after an await it would pick up mutations
  // that belong to a later save, so an older save could persist newer state.
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
  const previous = saveChains.get(room.roomName) ?? Promise.resolve();
  // writeRoomFile never rejects, so the chain can't be poisoned by one bad save.
  const chained = previous.then(() => writeRoomFile(room.roomName, data));
  saveChains.set(room.roomName, chained);
  void chained.then(() => {
    // Only the tail clears the entry; clearing unconditionally would let the
    // next save start a second, unordered chain for the same room.
    if (saveChains.get(room.roomName) === chained) saveChains.delete(room.roomName);
  });
  return chained;
};

// Debounced room save; a burst of swipes coalesces into one write per room.
// A crash loses at most this window, the price of not writing per swipe.
const SAVE_DEBOUNCE_MS = 2000;

// Ceiling on unpersisted time. Trailing-edge debounce alone never fires for a
// room swiped faster than SAVE_DEBOUNCE_MS, so the busiest room would never save.
const SAVE_MAX_WAIT_MS = 10000;

// Hold the Room with the timer: it may be gone from the registry by flush time.
interface PendingSave {
  timer: ReturnType<typeof setTimeout>;
  room: Room;
  // Preserved across re-arms so max-wait measures from the first unsaved change.
  firstScheduledAt: number;
}
const pendingSaves = new Map<string, PendingSave>();

export const scheduleSaveRoom = (room: Room): void => {
  const existing = pendingSaves.get(room.roomName);
  const now = Date.now();
  const firstScheduledAt = existing?.firstScheduledAt ?? now;
  if (existing) clearTimeout(existing.timer);
  // Cap the write at SAVE_MAX_WAIT_MS from the first unsaved mutation; clamp
  // at 0 so an overdue room writes next tick instead of taking a negative delay.
  const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, firstScheduledAt + SAVE_MAX_WAIT_MS - now));
  const timer = setTimeout(() => {
    pendingSaves.delete(room.roomName);
    void saveRoom(room);
  }, delay);
  pendingSaves.set(room.roomName, { timer, room, firstScheduledAt });
};

// Drop a queued save without writing, so it can't resurrect a room file
// cleanupExpiredRooms just unlinked.
export const cancelPendingSave = (roomName: string): void => {
  const entry = pendingSaves.get(roomName);
  if (entry) {
    clearTimeout(entry.timer);
    pendingSaves.delete(roomName);
  }
};

// Flush every queued save now so shutdown can't lose a swipe still inside the
// debounce window. allSettled: one failed save must not skip the rest.
export const flushPendingSaves = async (): Promise<void> => {
  const pending = [...pendingSaves.values()];
  pendingSaves.clear();
  for (const { timer } of pending) clearTimeout(timer);
  await Promise.allSettled(pending.map(({ room }) => saveRoom(room)));
  // The fire-and-forget saves (join, disconnect, applyFilters, a debounce timer
  // that already fired) were never in pendingSaves. Without this the flush is
  // not a barrier: one of them can rename over its output after it returns.
  await Promise.allSettled([...saveChains.values()]);
};

export const loadRoom = async (roomName: string, ctx: RouteContext): Promise<Room | null> => {
  try {
    const raw = await readFile(roomFilePath(roomName), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    // JSON.parse proves valid JSON, not PersistedRoom shape; reject rather
    // than feed a truncated file half-undefined into a Room.
    if (!isPersistedRoomShape(parsed, roomName)) return null;
    const data = parsed;
    const req: CreateRoomRequest = {
      // Filename is the canonical identity (Map key, URL param); a disagreeing
      // in-body `data.roomName` must not win.
      roomName,
      displayName: data.displayName ?? roomName,
      filters: sanitizeLoadedFilters(roomName, data.filters),
    };
    const room = new Room(req, ctx);
    await room.media;
    // Array.isArray above only proves it is an array. A malformed tuple inside
    // would build a Map of corrupt values with no error.
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
    // Rebuild the reverse index storeRating otherwise maintains incrementally.
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
    // Element-validate like ratings. A string progress makes storeRating
    // concatenate ("12" + 1 === "121"); null gives NaN, which serializes as
    // `progress: null` to a frontend typed for number.
    const isProgressEntry = (e: unknown): e is [string, number] =>
      Array.isArray(e) && e.length === 2 &&
      typeof e[0] === 'string' &&
      typeof e[1] === 'number' && Number.isFinite(e[1]);
    if (!data.userProgress.every(isProgressEntry)) {
      logger.error(`Room file "${roomName}" has malformed userProgress; ignoring it.`);
      return null;
    }
    room.userProgress = new Map(data.userProgress);
    room.createdAt = data.createdAt;
    room.lastSwipeAt = data.lastSwipeAt ?? data.updatedAt;
    logger.info(`Restored room "${roomName}" from disk.`);
    return room;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // File exists but wouldn't restore, usually a failed provider refetch
      // (Plex down, or filters now match nothing). Kept on disk for next time.
      logger.error(
        `Failed to restore room "${roomName}" from disk (file kept; ` +
          `most likely the provider refetch failed): ${String(err)}`,
      );
    }
    return null;
  }
};

// Deliberately generous. A real save renames within milliseconds, so an hour
// old means abandoned rather than in flight, including a tmp belonging to
// another process sharing the data volume.
const TMP_FILE_MAX_AGE_MS = 60 * 60 * 1000;

// A save killed between writeFile and rename strands its tmp file, and the
// .json filter in the disk pass would skip it forever.
const reapStaleTmpFile = async (filePath: string, now: number): Promise<void> => {
  try {
    const { mtimeMs } = await stat(filePath);
    if (now - mtimeMs < TMP_FILE_MAX_AGE_MS) return;
    await unlink(filePath);
    logger.info(`Removed abandoned room temp file ${filePath}`);
  } catch (err) {
    // ENOENT means a rename or another sweep got there first.
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      logger.warn(`Failed to remove room temp file ${filePath}: ${e.message}`);
    }
  }
};

// Sweep in-memory rooms and room files idle past ttlMs. The only expiry policy.
//
// A room with connected clients is never expired: eviction orphans their Room
// references and lets a fresh join build a second, divergent Room (split-brain).
export const cleanupExpiredRooms = async (ttlMs: number = ROOM_TTL_MS): Promise<void> => {
  const now = Date.now();
  const cutoff = now - ttlMs;

  // getAllRooms() snapshots, so mutating the registry while iterating is safe.
  for (const room of getAllRooms()) {
    if (room.users.size > 0) continue; // in active use, keep it
    if (room.lastSwipeAt < cutoff) {
      // Cancel first, or the timer fires after the unlink and recreates the file.
      cancelPendingSave(room.roomName);
      // Unlink BEFORE removeRoom: remove-first lets a concurrent createRoom
      // pass `hasRoom` and save in the gap, and this unlink then deletes its
      // fresh file. Unlink-first makes that createRoom hit RoomExistsError.
      const filePath = roomFilePath(room.roomName);
      // EACCES/EBUSY/EISDIR mean broken permissions or a bad mount, worth
      // logging. ENOENT is benign: a previous sweep may already have won.
      await unlink(filePath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') {
          logger.error(
            `Failed to unlink expired room file ${filePath}: ${err.message}`,
          );
        }
      });
      // Re-check occupancy after the await: a queued joinRoom can reach
      // users.set() during the I/O wait. Removing it now would split-brain,
      // so keep the room and re-persist the file just unlinked.
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

  // Disk pass: rooms persisted before this process started, never loaded here.
  try {
    await mkdir(ROOMS_DIR, { recursive: true });
    const files = await readdir(ROOMS_DIR);
    for (const file of files) {
      if (file.endsWith('.tmp')) {
        await reapStaleTmpFile(join(ROOMS_DIR, file), now);
        continue;
      }
      if (!file.endsWith('.json')) continue;
      // Live rooms belong to the pass above; the disk pass must not delete
      // their files. Filename minus .json is the canonical name.
      const canonicalName = file.slice(0, -'.json'.length);
      if (hasRoom(canonicalName)) continue;
      const filePath = join(ROOMS_DIR, file);
      let data: PersistedRoom;
      try {
        const raw = await readFile(filePath, 'utf-8');
        // A non-object JSON literal (`42`, `null`) parses fine but throws on
        // property access. The sweep reads two timestamps, so a shallow object
        // check is enough; isPersistedRoomShape would be overkill.
        const parsed: unknown = JSON.parse(raw);
        data = (parsed && typeof parsed === 'object')
          ? (parsed as PersistedRoom)
          : ({} as PersistedRoom);
      } catch (err) {
        // Only a parse failure proves the contents are garbage. EACCES, EMFILE,
        // EIO and EBUSY say nothing about the file, and deleting on them throws
        // away a room a later sweep could have read; loadRoom keeps the file
        // for the same reason.
        if (err instanceof SyntaxError) {
          await unlink(filePath).catch(() => {});
          // Full filePath, not the basename: an operator greps for the path.
          logger.warn(`Removed corrupt room file ${filePath}: ${err.message}`);
        } else {
          logger.error(
            `Could not read room file ${filePath} (kept): ${(err as Error).message}`,
          );
        }
        continue;
      }
      const effectiveLastSwipe = data.lastSwipeAt ?? data.updatedAt;
      // No usable timestamp counts as ancient: `undefined < cutoff` is false,
      // so without the explicit check such files never sweep.
      if (effectiveLastSwipe === undefined || effectiveLastSwipe < cutoff) {
        // Re-check after the readFile await: a queued join can run
        // loadRoom -> saveRoom during the I/O window, and unlinking that
        // fresh file leaves an active room with no disk presence.
        if (hasRoom(canonicalName)) continue;
        // Its own catch, outside the read: a failed unlink is a permissions or
        // mount problem, not a corrupt file, and must not be logged as one.
        try {
          await unlink(filePath);
          logger.info(
            `Expired room file ${filePath}` +
              (effectiveLastSwipe === undefined ? ' (no timestamp -- treated as ancient)' : ''),
          );
        } catch (err) {
          // ENOENT is benign: another sweep or an operator already removed it.
          const e = err as NodeJS.ErrnoException;
          if (e.code !== 'ENOENT') {
            logger.error(`Failed to unlink expired room file ${filePath}: ${e.message}`);
          }
        }
      }
    }
  } catch (err) {
    logger.error(`TTL sweep dir scan failed: ${String(err)}`);
  }
};

