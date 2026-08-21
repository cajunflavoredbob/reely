import { describe, it, expect, vi } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import { Room } from '../../internal/app/reely/room';
import type { RouteContext } from '../../internal/app/reely/types';
import type { Rate } from '../../types/reely';

const ALL_MEDIA = [
  { id: 'm1', type: 'movie', title: 'Film One' },
  { id: 'm2', type: 'movie', title: 'Film Two' },
];

const makeRoom = (): Room => {
  const ctx = {
    providers: [
      {
        // Must honour `title`: a filter-ignoring stub lets the archive test
        // pass without narrowing anything.
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

  // Guards against every later rating re-broadcasting an existing match.
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

  // The match gained a member, and that user should see their own match.
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
  // broadcastMessage uses sendRaw, notifyMatch uses sendMessage: stub both.
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
    // Guards against a match reaching someone who never rated it: the join
    // snapshot only returns matches the requesting user liked, so they would
    // lose the entry on rejoin.
    expect(matchFrames(carol)).toHaveLength(0);
  });

  it('keeps an existing match visible after a filter excludes its title', async () => {
    const room = makeRoom();
    await room.media;
    room.notifyMatch = vi.fn();

    await room.storeRating('alice', like('m1'), Date.now());
    await room.storeRating('bob', like('m1'), Date.now());
    // Archiving only happens at the filter boundary, where a title becomes
    // unservable; the current media set still serves this one.
    expect(room.matchedMedia.has('m1')).toBe(false);

    // Guards against a match vanishing on rejoin once a filter excludes its
    // title: getMatches must not resolve through the current media map alone.
    await room.applyFilters([{ key: 'title', operator: '=', value: ['Film Two'] }]);
    expect(room.matchedMedia.has('m1')).toBe(true);

    const matches = await room.getMatches('alice', false);
    expect(matches).toHaveLength(1);
    expect(matches[0].media.id).toBe('m1');
  });
});
