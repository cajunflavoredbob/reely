import { describe, it, expect, vi, afterEach } from 'vitest';

import { loggerMockFactory, makeMedia } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import {
  addRoom,
  createRoom,
  getRoom,
  removeRoom,
  getAllRooms,
  safeProgress,
  RoomExistsError,
  RoomLimitError,
  RoomNotFoundError,
} from '../../internal/app/reely/room';
import type { Room } from '../../internal/app/reely/room';
import type { Client } from '../../internal/app/reely/client';
import type { RouteContext } from '../../internal/app/reely/types';
import type { Media } from '../../types/reely';

// Only the fields getRoom reads.
const stubRoom = (name: string): Room => ({
  roomName: name,
  users: new Map<string, Client>(),
} as unknown as Room);

// Mirrors the module-private MAX_ROOMS. Nothing exports it, and exporting it
// only for the tests would widen the module's surface, so the literal is
// repeated here; the addRoom cases below fail loudly if the two drift.
const MAX_ROOMS = 500;

const clearRegistry = () => {
  for (const room of getAllRooms()) removeRoom(room.roomName);
};

/** Fills the registry with stub rooms up to `count` entries. */
const fillRegistry = (count: number, prefix = 'filler') => {
  for (let i = getAllRooms().length; i < count; i += 1) {
    addRoom(stubRoom(`${prefix}-${i}`));
  }
};

const instantCtx = (): RouteContext =>
  ({ providers: [{ getMedia: async () => [makeMedia()] }] } as unknown as RouteContext);

/**
 * RouteContext whose getMedia parks until the returned `release` is called, so
 * a test can act on the registry while a create is mid-fetch. That window is
 * the whole point: every check createRoom makes before the await is stale by
 * the time it commits.
 */
const gatedCtx = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ctx = {
    providers: [{ getMedia: async (): Promise<Media[]> => { await gate; return [makeMedia()]; } }],
  } as unknown as RouteContext;
  return { ctx, release };
};

describe('getRoom', () => {
  // The rooms Map is module-level, so it leaks between tests. removeRoom is
  // memory-only, safe here because no test writes a backing file.
  afterEach(() => {
    for (const room of getAllRooms()) removeRoom(room.roomName);
  });

  it('throws RoomNotFoundError for an unknown room', () => {
    expect(() => getRoom('ghost')).toThrow(RoomNotFoundError);
  });

  it('returns the room for a new user', () => {
    const room = stubRoom('open-a');
    addRoom(room);
    expect(getRoom('open-a')).toBe(room);
  });

  it('allows the same user to rejoin, overwriting the stale WS entry', () => {
    const room = stubRoom('open-b');
    room.users.set('alice', {} as Client);
    addRoom(room);
    expect(getRoom('open-b')).toBe(room);
  });

  it('allows a different user to join a room that already has a member', () => {
    const room = stubRoom('open-c');
    room.users.set('alice', {} as Client);
    addRoom(room);
    expect(getRoom('open-c')).toBe(room);
  });
});

describe('addRoom', () => {
  afterEach(clearRegistry);

  it('refuses a new room once the registry is at the cap', () => {
    fillRegistry(MAX_ROOMS);
    expect(() => addRoom(stubRoom('one-too-many'))).toThrow(RoomLimitError);
    expect(getAllRooms()).toHaveLength(MAX_ROOMS);
  });

  it('still accepts a room whose name is already registered', () => {
    fillRegistry(MAX_ROOMS);
    // Overwriting a key is not a new room, so the disk-load path can refresh an
    // existing entry even at the cap.
    const replacement = stubRoom('filler-0');
    expect(() => addRoom(replacement)).not.toThrow();
    expect(getRoom('filler-0')).toBe(replacement);
  });
});

describe('createRoom', () => {
  afterEach(clearRegistry);

  it('registers the room under its canonical name', async () => {
    const room = await createRoom({ roomName: 'movie night' }, instantCtx());
    expect(getRoom('movie night')).toBe(room);
    expect(room.displayName).toBe('movie night');
  });

  it('uses displayName when the request carries one', async () => {
    const room = await createRoom(
      { roomName: 'movie night', displayName: 'Movie Night' },
      instantCtx(),
    );
    expect(room.displayName).toBe('Movie Night');
  });

  it('throws RoomExistsError for a name already registered', async () => {
    addRoom(stubRoom('taken'));
    await expect(createRoom({ roomName: 'taken' }, instantCtx())).rejects.toThrow(
      RoomExistsError,
    );
  });

  it('throws RoomLimitError when the registry is already full', async () => {
    fillRegistry(MAX_ROOMS);
    await expect(createRoom({ roomName: 'overflow' }, instantCtx())).rejects.toThrow(
      RoomLimitError,
    );
  });

  // Without the post-await has() check the later writer overwrites the entry,
  // leaving the first creator's client attached to a Room nothing can reach.
  it('rejects the loser when two creates for one name race through the fetch', async () => {
    const first = gatedCtx();
    const second = gatedCtx();
    const a = createRoom({ roomName: 'race' }, first.ctx);
    const b = createRoom({ roomName: 'race' }, second.ctx).catch((e: unknown) => e);
    first.release();
    const winner = await a;
    second.release();
    expect(await b).toBeInstanceOf(RoomExistsError);
    expect(getRoom('race')).toBe(winner);
  });

  // The size check runs before a multi-second Plex fetch, so it is stale by the
  // time the room commits; MAX_ROOMS is the only backstop against a flood.
  it('re-checks the room cap after the media fetch, not just before it', async () => {
    fillRegistry(MAX_ROOMS - 1);
    const { ctx, release } = gatedCtx();
    const pending = createRoom({ roomName: 'late' }, ctx).catch((e: unknown) => e);
    // The registry fills while the create is parked on its fetch.
    fillRegistry(MAX_ROOMS, 'latecomer');
    release();
    expect(await pending).toBeInstanceOf(RoomLimitError);
    expect(getAllRooms()).toHaveLength(MAX_ROOMS);
  });
});

describe('safeProgress', () => {
  it.each([
    [0, 0, 0],
    [5, 0, 0],      // empty media set: no Infinity on the wire
    [0, 10, 0],
    [5, 10, 0.5],
    [10, 10, 1],
    [51, 40, 1],    // clamped: loadRoom can restore a count past the new total
    [1, -3, 0],
  ])('safeProgress(%i, %i) is %f', (count, total, expected) => {
    expect(safeProgress(count, total)).toBe(expected);
  });

  it('never returns a non-finite value', () => {
    for (const [count, total] of [[1, 0], [0, 0], [Number.MAX_SAFE_INTEGER, 1]]) {
      expect(Number.isFinite(safeProgress(count, total))).toBe(true);
    }
  });
});
