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

// Room has complex dependencies; mock the module so loadRoom tests aren't blocked
// by ws/express imports. Only saveRoom and cleanupExpiredRooms are tested here.
// getAllRooms / removeRoom are mocked too so the TTL sweep can iterate test
// fixtures. Mock factories are hoisted above top-level
// statements, so the vi.fn()s must be created inline; we recover handles via
// vi.mocked() after the import.
vi.mock('../../internal/app/reely/room', () => ({
  Room: class {},
  getAllRooms: vi.fn().mockReturnValue([]),
  removeRoom: vi.fn(),
  hasRoom: vi.fn().mockReturnValue(false),
}));

import * as fs from 'node:fs/promises';
// readdir has multiple overloads (with/without options + the
// withFileTypes Dirent variant); vi.mocked can't always pick the right
// one, which is why these mocks used to carry `as any` casts (audit
// 13 #340). Helper hides the bypass in one place. `as never` is the
// honest escape hatch: assignable to any overload return type and
// signals "intentionally bypassing the type system for a test stub."
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

  // #4: a room with clients still connected must not be expired even when
  // its lastSwipeAt is stale -- evicting it would split-brain the room.
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

  // #4: the disk pass must not delete the file of a room currently in memory
  // (that room is the in-memory pass's responsibility). The file is skipped
  // before it's even read.
  it('skips a persisted file whose room is currently in memory', async () => {
    mockHasRoom.mockReturnValue(true);
    mockReaddirOnce(['live.json']);

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();
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
      // No lastSwipeAt field; only updatedAt.
      JSON.stringify({ updatedAt: stale }) as never,
    );

    await cleanupExpiredRooms(ROOM_TTL_MS);

    expect(vi.mocked(fs.unlink)).toHaveBeenCalledOnce();
  });

  // Audit 12 #204: a file with neither lastSwipeAt nor updatedAt yielded
  // `undefined < cutoff === false`, so the sweep skipped it forever.
  // 0.4.9 treats `undefined` as ancient and sweeps the file.
  it('sweeps a persisted file with no timestamp at all (audit 12 #204)', async () => {
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

// Audit 10 #131 + #158: the debounced save queue is shared with the TTL
// sweep + app shutdown. A save scheduled within the 2s window before either
// would otherwise fire after the file was unlinked (re-creating it) OR
// after the process was already exiting (silently lost).
describe('scheduleSaveRoom / cancelPendingSave / flushPendingSaves', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAllRooms.mockReturnValue([]);
    mockHasRoom.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes after the debounce window elapses', async () => {
    const room = makeRoom({ roomName: 'debounce-write' });
    scheduleSaveRoom(room);
    // Debounce is 2s; before that no write should land.
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
    // Past the original 2s mark -- but the latest schedule reset the timer.
    await vi.advanceTimersByTimeAsync(1500);
    expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
    // Now finish the window from the latest schedule.
    await vi.advanceTimersByTimeAsync(1000);
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
    // After flush, the timers should be cancelled -- advancing time must
    // not produce additional writes.
    vi.mocked(fs.writeFile).mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(fs.writeFile)).not.toHaveBeenCalled();
  });

  // #131: a save scheduled within the 2s window before cleanupExpiredRooms
  // unlinks the file would otherwise fire afterward and recreate it.
  // cleanupExpiredRooms must cancel the pending save first.
  it('cleanupExpiredRooms cancels a pending save for an expiring room (audit 10 #131)', async () => {
    const stale = Date.now() - (ROOM_TTL_MS + 60_000);
    const room = makeRoom({ roomName: 'expiring', lastSwipeAt: stale });
    mockGetAllRooms.mockReturnValue([room]);
    scheduleSaveRoom(room);
    await cleanupExpiredRooms(ROOM_TTL_MS);
    // The sweep should have removed the room AND unlinked the file.
    expect(mockRemoveRoom).toHaveBeenCalledWith('expiring');
    expect(vi.mocked(fs.unlink)).toHaveBeenCalled();
    // Now advance past the debounce window -- the cancelled timer must NOT
    // fire a saveRoom that would recreate the unlinked file.
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

  // #22: JSON.parse succeeds but the object isn't a PersistedRoom -- loadRoom
  // must reject it rather than feed half-undefined fields into a Room.
  it('returns null for valid JSON with the wrong shape', async () => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      JSON.stringify({ roomName: 'r' }) as never, // missing ratings/userProgress/createdAt
    );
    expect(await loadRoom('wrong-shape', {} as never)).toBeNull();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringContaining('invalid shape'),
    );
  });

  // Audit 12 #205: per-field shape check covers every required PersistedRoom
  // field + types every optional field. Each branch's reject message names
  // the offending field so an operator hand-editing the file gets a clue.
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
  ])('rejects a room file with $name (audit 12 #205)', async ({ body, reason }) => {
    vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(body) as never);
    expect(await loadRoom('bad', {} as never)).toBeNull();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.stringMatching(reason),
    );
  });
});
