import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  readdir: vi.fn().mockResolvedValue([]),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

// Mocked so these tests do not drag in ws/express, and so the TTL sweep
// iterates fixtures. The factory is hoisted, so the vi.fn()s are inline and
// the handles come back through vi.mocked() after the import.
vi.mock('../../internal/app/reely/room', () => ({
  Room: class {},
  getAllRooms: vi.fn().mockReturnValue([]),
  removeRoom: vi.fn(),
  hasRoom: vi.fn().mockReturnValue(false),
}));

import * as fs from 'node:fs/promises';
// readdir's overloads defeat vi.mocked, so the cast lives here once. `as
// never` is assignable to any of the overload return types.
const mockReaddirOnce = (entries: string[]) =>
  vi.mocked(fs.readdir).mockResolvedValueOnce(entries as never);
import {
  saveRoom,
  loadRoom,
  cleanupExpiredRooms,
  scheduleSaveRoom,
  cancelPendingSave,
  flushPendingSaves,
  ROOM_TTL_MS,
} from '../../internal/app/reely/roomStore';
import { logger } from '../../internal/app/reely/logger';
import { getAllRooms, removeRoom, hasRoom } from '../../internal/app/reely/room';
import type { Room } from '../../internal/app/reely/room';

const mockGetAllRooms = vi.mocked(getAllRooms);
const mockRemoveRoom = vi.mocked(removeRoom);
const mockHasRoom = vi.mocked(hasRoom);

const makeRoom = (overrides: Partial<{
  roomName: string;
  filters: unknown;
  ratings: Map<string, unknown[]>;
  userProgress: Map<string, number>;
  createdAt: number;
  lastSwipeAt: number;
  users: Map<string, unknown>;
}> = {}): Room => ({
  roomName: 'testroom',
  filters: undefined,
  ratings: new Map(),
  userProgress: new Map(),
  createdAt: 1000,
  lastSwipeAt: Date.now(),
  users: new Map(),
  ...overrides,
} as unknown as Room);

describe('saveRoom', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('writes a JSON file with the correct structure', async () => {
    const room = makeRoom({ roomName: 'myroom', createdAt: 5000 });
    await saveRoom(room);

    expect(vi.mocked(fs.mkdir)).toHaveBeenCalledOnce();
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalledOnce();

    const [filePath, content] = vi.mocked(fs.writeFile).mock.calls[0];
    expect(String(filePath)).toContain('myroom.json');

    const parsed = JSON.parse(String(content));
    expect(parsed.roomName).toBe('myroom');
    expect(parsed.createdAt).toBe(5000);
    expect(parsed.updatedAt).toBeGreaterThan(0);
    expect(Array.isArray(parsed.ratings)).toBe(true);
    expect(Array.isArray(parsed.userProgress)).toBe(true);
  });

  it('serializes ratings Map entries as nested arrays', async () => {
    const ratings = new Map<string, Array<[string, string, number]>>();
    ratings.set('media-1', [['alice', 'like', 9000]]);
    ratings.set('media-2', [['alice', 'dislike', 9001], ['bob', 'like', 9002]]);

    const room = makeRoom({ ratings });
    await saveRoom(room);

    const content = String(vi.mocked(fs.writeFile).mock.calls[0][1]);
    const parsed = JSON.parse(content);
    expect(parsed.ratings).toEqual([
      ['media-1', [['alice', 'like', 9000]]],
      ['media-2', [['alice', 'dislike', 9001], ['bob', 'like', 9002]]],
    ]);
  });

  it('serializes userProgress Map entries as nested arrays', async () => {
    const userProgress = new Map([['alice', 5], ['bob', 12]]);
    const room = makeRoom({ userProgress });
    await saveRoom(room);

    const content = String(vi.mocked(fs.writeFile).mock.calls[0][1]);
    const parsed = JSON.parse(content);
    expect(parsed.userProgress).toEqual([['alice', 5], ['bob', 12]]);
  });

  it('logs an error and does not throw if writeFile fails', async () => {
    vi.mocked(fs.writeFile).mockRejectedValueOnce(new Error('disk full'));
    await expect(saveRoom(makeRoom())).resolves.toBeUndefined();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to save room'),
    );
  });
});

describe('cleanupExpiredRooms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllRooms.mockReturnValue([]);
    mockHasRoom.mockReturnValue(false);
  });

  it('exports ROOM_TTL_MS at 6 hours', () => {
    expect(ROOM_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it('evicts an in-memory room whose lastSwipeAt is older than the TTL', async () => {
    const stale = Date.now() - (ROOM_TTL_MS + 60_000);
    mockGetAllRooms.mockReturnValueOnce([
      makeRoom({ roomName: 'stale', lastSwipeAt: stale }),
    ]);

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(mockRemoveRoom).toHaveBeenCalledWith('stale');
    expect(vi.mocked(fs.unlink)).toHaveBeenCalled();
    expect(String(vi.mocked(fs.unlink).mock.calls[0][0])).toContain('stale.json');
  });

  it('keeps an in-memory room whose lastSwipeAt is within the TTL', async () => {
    const fresh = Date.now() - 60_000;
    mockGetAllRooms.mockReturnValueOnce([
      makeRoom({ roomName: 'fresh', lastSwipeAt: fresh }),
    ]);

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(mockRemoveRoom).not.toHaveBeenCalled();
    expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();
  });

  // Evicting a room that still has connected clients splits the room.
  it('keeps a stale in-memory room that still has connected clients', async () => {
    const stale = Date.now() - (ROOM_TTL_MS + 60_000);
    mockGetAllRooms.mockReturnValueOnce([
      makeRoom({
        roomName: 'occupied',
        lastSwipeAt: stale,
        users: new Map([['alice', {}]]),
      }),
    ]);

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(mockRemoveRoom).not.toHaveBeenCalled();
    expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();
  });

  // An in-memory room is the in-memory pass's business, so the disk pass
  // skips its file before reading it.
  it('skips a persisted file whose room is currently in memory', async () => {
    mockHasRoom.mockReturnValue(true);
    mockReaddirOnce(['live.json']);

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();
  });

  // A join can run loadRoom, addRoom and saveRoom during the readFile await,
  // making this pass's buffer stale. Unlinking then deletes a file just
  // written for a live room, and the in-memory pass is already done for this
  // cycle, so nothing re-persists it.
  it('does not delete a file for a room that came live during the readFile await', async () => {
    const stale = Date.now() - (ROOM_TTL_MS + 60_000);
    mockReaddirOnce(['revived.json']);
    mockHasRoom.mockReturnValue(false);
    vi.mocked(fs.readFile).mockImplementationOnce((async () => {
      // A join lands mid-await and brings the room into memory.
      mockHasRoom.mockReturnValue(true);
      return JSON.stringify({ updatedAt: stale, lastSwipeAt: stale });
    }) as never);

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();
  });

  it('evicts persisted-only rooms (not currently in memory) whose lastSwipeAt is expired', async () => {
    const stale = Date.now() - (ROOM_TTL_MS + 60_000);
    mockReaddirOnce(['stale-disk.json']);
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ updatedAt: stale, lastSwipeAt: stale }) as never,
    );

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(vi.mocked(fs.unlink)).toHaveBeenCalledOnce();
    expect(String(vi.mocked(fs.unlink).mock.calls[0][0])).toContain('stale-disk.json');
  });

  it('falls back to updatedAt when a persisted room has no lastSwipeAt (pre-0.2.20 file)', async () => {
    const stale = Date.now() - (ROOM_TTL_MS + 60_000);
    mockReaddirOnce(['legacy.json']);
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      // updatedAt only.
      JSON.stringify({ updatedAt: stale }) as never,
    );

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(vi.mocked(fs.unlink)).toHaveBeenCalledOnce();
  });

  // With no timestamp at all, `undefined < cutoff` is false and the sweep
  // skips the file forever, so undefined counts as ancient.
  it('sweeps a persisted file with no timestamp at all', async () => {
    mockReaddirOnce(['untimestamped.json']);
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ roomName: 'untimestamped' }) as never,
    );

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(vi.mocked(fs.unlink)).toHaveBeenCalledOnce();
    expect(String(vi.mocked(fs.unlink).mock.calls[0][0])).toContain('untimestamped.json');
  });

  it('keeps persisted rooms within the TTL window', async () => {
    const fresh = Date.now() - 60_000;
    mockReaddirOnce(['fresh.json']);
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ updatedAt: fresh, lastSwipeAt: fresh }) as never,
    );

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(vi.mocked(fs.unlink)).not.toHaveBeenCalled();
  });

  it('removes and warns about unreadable room files', async () => {
    mockReaddirOnce(['corrupt.json']);
    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('corrupt'));

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(vi.mocked(fs.unlink)).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('corrupt.json'),
    );
  });
});

// The debounced save queue is shared with the TTL sweep and app shutdown. A
// save scheduled inside the 2s window before either fires after the file was
// unlinked, recreating it, or after the process is exiting, losing it.
describe('scheduleSaveRoom / cancelPendingSave / flushPendingSaves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAllRooms.mockReturnValue([]);
    mockHasRoom.mockReturnValue(false);
  });

  afterEach(() => {
    // Before real timers return: pendingSaves is module state, so a leaked
    // entry fails an unrelated test too. Here, not after an assertion that
    // can throw first.
    for (const name of ['debounce-write', 'coalesce', 'busy']) cancelPendingSave(name);
    vi.useRealTimers();
  });

  it('writes after the debounce window elapses', async () => {
    const room = makeRoom({ roomName: 'debounce-write' });
    scheduleSaveRoom(room);
    // The debounce is 2s.
    await vi.advanceTimersByTimeAsync(1500);
    expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalledOnce();
  });

  it('coalesces bursts: many schedules within the window produce one write', async () => {
    const room = makeRoom({ roomName: 'coalesce' });
    scheduleSaveRoom(room);
    await vi.advanceTimersByTimeAsync(500);
    scheduleSaveRoom(room);
    await vi.advanceTimersByTimeAsync(500);
    scheduleSaveRoom(room);
    // Past the original 2s mark, but the latest schedule reset the timer.
    await vi.advanceTimersByTimeAsync(1500);
    expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
    // Finish the window from the latest schedule.
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalledOnce();
  });

  it('still writes while activity never stops, at the max-wait ceiling', async () => {
    // Two people swiping produce a rating about every second, inside the
    // debounce window, so a trailing-edge-only timer re-arms forever and a
    // busy room writes nothing while an idle one persists. The max-wait
    // bounds it at 10s from the first unsaved change.
    const room = makeRoom({ roomName: 'busy' });
    for (let elapsed = 0; elapsed < 11_000; elapsed += 1000) {
      scheduleSaveRoom(room);
      await vi.advanceTimersByTimeAsync(1000);
    }
    // Bounded, not a write per swipe.
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalledOnce();
  });

  it('cancelPendingSave drops a queued save without writing', async () => {
    const room = makeRoom({ roomName: 'cancelled' });
    scheduleSaveRoom(room);
    cancelPendingSave('cancelled');
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
  });

  it('flushPendingSaves writes every queued save now and clears the queue', async () => {
    scheduleSaveRoom(makeRoom({ roomName: 'a' }));
    scheduleSaveRoom(makeRoom({ roomName: 'b' }));
    expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
    await flushPendingSaves();
    expect(vi.mocked(fs.writeFile)).toHaveBeenCalledTimes(2);
    // Flush cancels the timers, so time produces no further writes.
    vi.mocked(fs.writeFile).mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
  });

  // An uncancelled save fires after the unlink and recreates the file.
  it('cleanupExpiredRooms cancels a pending save for an expiring room', async () => {
    const stale = Date.now() - (ROOM_TTL_MS + 60_000);
    const room = makeRoom({ roomName: 'expiring', lastSwipeAt: stale });
    mockGetAllRooms.mockReturnValue([room]);
    scheduleSaveRoom(room);
    await cleanupExpiredRooms(ROOM_TTL_MS);
    expect(mockRemoveRoom).toHaveBeenCalledWith('expiring');
    expect(vi.mocked(fs.unlink)).toHaveBeenCalled();
    // Past the debounce window, with the timer cancelled.
    vi.mocked(fs.writeFile).mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
  });
});

describe('loadRoom', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns null for a syntactically invalid room file', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce('{ not json' as never);
    expect(await loadRoom('broken', {} as never)).toBeNull();
  });

  // Parseable JSON that is not a PersistedRoom must be rejected, not fed
  // into a Room as half-undefined fields.
  it('returns null for valid JSON with the wrong shape', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ roomName: 'r' }) as never, // no ratings/userProgress/createdAt
    );
    expect(await loadRoom('wrong-shape', {} as never)).toBeNull();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining('invalid shape'),
    );
  });

  // Every required and optional PersistedRoom field is type-checked, and the
  // reject message names the offending field for anyone hand-editing a file.
  it.each([
    {
      name: 'updatedAt missing',
      body: { roomName: 'r', ratings: [], userProgress: [], createdAt: 1 },
      reason: /updatedAt/,
    },
    {
      name: 'displayName wrong type',
      body: { roomName: 'r', displayName: 123, ratings: [], userProgress: [], createdAt: 1, updatedAt: 2 },
      reason: /displayName/,
    },
    {
      name: 'filters wrong type',
      body: { roomName: 'r', filters: 'not-an-array', ratings: [], userProgress: [], createdAt: 1, updatedAt: 2 },
      reason: /filters/,
    },
    {
      name: 'lastSwipeAt wrong type',
      body: { roomName: 'r', ratings: [], userProgress: [], createdAt: 1, updatedAt: 2, lastSwipeAt: 'soon' },
      reason: /lastSwipeAt/,
    },
    // A string count reaches storeRating as ("12" + 1) === "121", which is
    // re-persisted and compounds while the display sticks at 100%.
    {
      name: 'a userProgress count that is not a number',
      body: { roomName: 'r', ratings: [], userProgress: [['alice', '12']], createdAt: 1, updatedAt: 2 },
      reason: /userProgress/,
    },
    {
      name: 'a null userProgress count (reaches the wire as progress: null)',
      body: { roomName: 'r', ratings: [], userProgress: [['alice', null]], createdAt: 1, updatedAt: 2 },
      reason: /userProgress/,
    },
    {
      name: 'a userProgress entry that is not a pair',
      body: { roomName: 'r', ratings: [], userProgress: [['alice']], createdAt: 1, updatedAt: 2 },
      reason: /userProgress/,
    },
  ])('rejects a room file with $name', async ({ body, reason }) => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(body) as never);
    expect(await loadRoom('bad', {} as never)).toBeNull();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringMatching(reason),
    );
  });
});

describe('loadRoom filter sanitisation', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it.each([
    { name: 'an operator the query builder would corrupt', operator: '<', key: 'genre' },
    { name: 'a key that is not a plain identifier', operator: '=', key: '../../etc/passwd' },
  ])('drops $name but keeps the room', async ({ operator, key }) => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({
        roomName: 'movies',
        ratings: [['m1', [['alice', 'like', 9000]]]],
        userProgress: [['alice', 5]],
        createdAt: 1,
        updatedAt: 2,
        filters: [{ key, operator, value: ['x'] }],
      }) as never,
    );

    const room = await loadRoom('movies', {
      providers: [{ getMedia: async () => [{ id: 'm1', type: 'movie', title: 'Film' }] }],
    } as never);

    // The filter must not reach the Plex query, but a null return makes the
    // join path build an empty room and overwrite the file, losing every
    // rating and match in it.
    expect(room).not.toBeNull();
    expect(room?.filters).toBeUndefined();
    expect(room?.ratings.get('m1')).toHaveLength(1);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringMatching(/invalid filter/),
    );
  });
});
