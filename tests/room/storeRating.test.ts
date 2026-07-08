import { describe, it, expect, vi } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import { Room } from '../../internal/app/reely/room';
import type { RouteContext } from '../../internal/app/reely/types';
import type { Rate } from '../../types/reely';

// A Room backed by a stub provider that returns two media items.
const makeRoom = (): Room => {
  const ctx = {
    providers: [
      {
        getMedia: async () => [
          { id: 'm1', type: 'movie', title: 'Film One' },
          { id: 'm2', type: 'movie', title: 'Film Two' },
        ],
      },
    ],
  } as unknown as RouteContext;
  return new Room({ roomName: 'r', displayName: 'r' }, ctx);
};

const like = (mediaId: string): Rate => ({ rating: 'like', mediaId });
const dislike = (mediaId: string): Rate => ({ rating: 'dislike', mediaId });

describe('Room.storeRating notifyMatch (audit #2)', () => {
  it('fires notifyMatch once when a second like forms a match', async () => {
    const room = makeRoom();
    await room.media;
    const notifyMatch = vi.fn();
    room.notifyMatch = notifyMatch;

    await room.storeRating('alice', like('m1'), Date.now());
    await room.storeRating('bob', like('m1'), Date.now());

    expect(notifyMatch).toHaveBeenCalledTimes(1);
  });

  // The bug: any later rating re-evaluated likes.length > 1 and re-broadcast.
  it('does not re-fire when a later dislike lands on an already-matched item', async () => {
    const room = makeRoom();
    await room.media;
    const notifyMatch = vi.fn();
    room.notifyMatch = notifyMatch;

    await room.storeRating('alice', like('m1'), Date.now());
    await room.storeRating('bob', like('m1'), Date.now());
    await room.storeRating('carol', dislike('m1'), Date.now());

    expect(notifyMatch).toHaveBeenCalledTimes(1);
  });

  // A third liker still notifies: the match genuinely gained a member, and
  // that user should see their own match moment.
  it('re-fires for a third liker', async () => {
    const room = makeRoom();
    await room.media;
    const notifyMatch = vi.fn();
    room.notifyMatch = notifyMatch;

    await room.storeRating('alice', like('m1'), Date.now());
    await room.storeRating('bob', like('m1'), Date.now());
    await room.storeRating('carol', like('m1'), Date.now());

    expect(notifyMatch).toHaveBeenCalledTimes(2);
  });
});
