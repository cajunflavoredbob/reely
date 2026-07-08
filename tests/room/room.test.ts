import { describe, it, expect, vi, afterEach } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import {
  addRoom,
  getRoom,
  removeRoom,
  getAllRooms,
  RoomNotFoundError,
} from '../../internal/app/reely/room';
import type { Room } from '../../internal/app/reely/room';
import type { Client } from '../../internal/app/reely/client';

// Minimal stub -- only the fields getRoom reads.
const stubRoom = (name: string): Room => ({
  roomName: name,
  users: new Map<string, Client>(),
} as unknown as Room);

describe('getRoom', () => {
  // Clean up the module-level rooms Map between tests (audit 12 #248).
  // The prior version relied on unique room names per test, but with
  // vitest's `clearMocks`/`restoreMocks` running between tests, the
  // mutable singleton state was the one leak left. removeRoom is the
  // public memory-only delete (audit 12 #203 -- safe here since the
  // tests never wrote a backing file).
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
