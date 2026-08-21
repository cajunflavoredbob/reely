import { describe, it, expect, vi } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import { Room } from '../../internal/app/reely/room';
import type { RouteContext } from '../../internal/app/reely/types';
import type { Rate } from '../../types/reely';

// A Room backed by a stub provider that returns two media items.
const ALL_MEDIA = [
  { id: 'm1', type: 'movie', title: 'Film One' },
  { id: 'm2', type: 'movie', title: 'Film Two' },
];

const makeRoom = (): Room => {
  const ctx = {
    providers: [
      {
        // Honours a `title` filter so applyFilters actually narrows the set.
        // A stub that ignored filters would let the archive test pass without
        // ever exercising the path it is meant to cover.
        getMedia: async (opts?: { filters?: { key: string; value: string[] }[] }) => {
          const titles = opts?.filters?.find((f) => f.key === 'title')?.value;
          return titles ? ALL_MEDIA.filter((m) => titles.includes(m.title)) : ALL_MEDIA;
        },
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

// ---------------------------------------------------------------------------

describe('Room match visibility', () => {
  // broadcastMessage uses sendRaw (stringify-once); notifyMatch targets
  // individual likers via sendMessage. The stub needs both.
  const fakeClient = () => ({ sendMessage: vi.fn(), sendRaw: vi.fn() });

  it('delivers a match only to the users who liked it', async () => {
    const room = makeRoom();
    await room.media;
    const alice = fakeClient();
    const bob = fakeClient();
    const carol = fakeClient();
    room.users = new Map(
      Object.entries({ alice, bob, carol }),
    ) as unknown as typeof room.users;

    await room.storeRating('alice', like('m1'), Date.now());
    await room.storeRating('bob', like('m1'), Date.now());

    const matchFrames = (c: ReturnType<typeof fakeClient>) =>
      c.sendMessage.mock.calls.filter(([m]) => (m as { type: string }).type === 'match');

    expect(matchFrames(alice)).toHaveLength(1);
    expect(matchFrames(bob)).toHaveLength(1);
    // Carol never rated it. She used to receive the frame and the celebration,
    // then lose the entry with no explanation on her next rejoin, because the
    // join snapshot only returns matches the requesting user liked.
    expect(matchFrames(carol)).toHaveLength(0);
  });

  it('keeps an existing match visible after a filter excludes its title', async () => {
    const room = makeRoom();
    await room.media;
    room.notifyMatch = vi.fn();

    await room.storeRating('alice', like('m1'), Date.now());
    await room.storeRating('bob', like('m1'), Date.now());
    // Nothing is archived yet: the current media set still serves the match,
    // so spending archive budget on it would be waste. Archiving happens at
    // the filter boundary, where a title actually becomes unservable.
    expect(room.matchedMedia.has('m1')).toBe(false);

    // A real filter change, through applyFilters, that excludes the matched
    // title. applyFilters deliberately preserves ratings for exactly this
    // reason; getMatches used to drop the match anyway because it resolved
    // through the current media map, so the match vanished on the next rejoin.
    await room.applyFilters([{ key: 'title', operator: '=', value: ['Film Two'] }]);
    expect(room.matchedMedia.has('m1')).toBe(true);

    const matches = await room.getMatches('alice', false);
    expect(matches).toHaveLength(1);
    expect(matches[0].media.id).toBe('m1');
  });
});
