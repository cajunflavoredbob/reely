import { describe, it, expect, vi } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import { NoMediaError, Room } from '../../internal/app/reely/room';
import type { RouteContext } from '../../internal/app/reely/types';
import type { Media, Rate } from '../../types/reely';

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

describe('Room.storeRating notifyMatch', () => {
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

// ---------------------------------------------------------------------------

describe('Room.archiveMatchedMedia FIFO cap', () => {
  // Archived entries hold whole Media objects, so an unbounded archive is the
  // one that actually costs memory.
  const CAP = 2000;

  /** Room over `count` synthetic titles, filterable down to a single one. */
  const makeWideRoom = (count: number) => {
    const all = Array.from({ length: count }, (_, i) => ({
      id: `m${i}`,
      type: 'movie',
      title: `Film ${i}`,
    }));
    const ctx = {
      providers: [
        {
          getMedia: async (opts?: { filters?: { key: string; value: string[] }[] }) => {
            const titles = opts?.filters?.find((f) => f.key === 'title')?.value;
            return titles ? all.filter((m) => titles.includes(m.title)) : all;
          },
        },
      ],
    } as unknown as RouteContext;
    return new Room({ roomName: 'wide', displayName: 'wide' }, ctx);
  };

  it('evicts the oldest entry past the cap and keeps the newest', async () => {
    const room = makeWideRoom(CAP + 10);
    await room.media;
    // Seed the ratings directly: this exercises the archive path, not the
    // notify path, and 2010 storeRating calls would only be slower.
    for (let i = 0; i < CAP + 10; i += 1) {
      room.ratings.set(`m${i}`, [
        ['alice', 'like', 1],
        ['bob', 'like', 2],
      ]);
    }

    // Everything but "Film 0" leaves the media set, so every other match needs
    // archiving.
    await room.applyFilters([{ key: 'title', operator: '=', value: ['Film 0'] }]);

    expect(room.matchedMedia.size).toBe(CAP);
    expect(room.matchedMedia.has('m1')).toBe(false); // oldest archived, evicted
    expect(room.matchedMedia.has(`m${CAP + 9}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('Room progress accounting', () => {
  const titleFilter = (...titles: string[]) => [
    { key: 'title', operator: '=', value: titles },
  ];

  it('rebases userProgress against the media set a filter leaves behind', async () => {
    const room = makeRoom();
    await room.media;

    await room.storeRating('alice', like('m1'), Date.now());
    await room.storeRating('alice', dislike('m2'), Date.now());
    expect(room.userProgress.get('alice')).toBe(2);

    // Alice rated both titles; only one survives the filter, so one of her two
    // ratings still counts toward the new denominator.
    await room.applyFilters(titleFilter('Film Two'));
    expect(room.userProgress.get('alice')).toBe(1);
  });

  // The symptom the clamp used to hide: a full ring while getMediaForUser is
  // still handing out unrated cards.
  it('does not report full progress when the surviving titles are unrated', async () => {
    const room = makeRoom();
    await room.media;

    await room.storeRating('alice', like('m1'), Date.now());
    await room.applyFilters(titleFilter('Film Two'));

    expect(room.userProgress.get('alice')).toBe(0);
    // The deck still has a card for her, so any non-zero progress is a lie.
    expect(await room.getMediaForUser('alice')).toHaveLength(1);
  });

  it('broadcasts the corrected progress to connected users', async () => {
    const room = makeRoom();
    await room.media;
    const alice = { sendMessage: vi.fn(), sendRaw: vi.fn() };
    room.users = new Map(Object.entries({ alice })) as unknown as typeof room.users;

    await room.storeRating('alice', like('m1'), Date.now());
    await room.storeRating('alice', dislike('m2'), Date.now());
    alice.sendRaw.mockClear();

    await room.applyFilters(titleFilter('Film Two'));

    // filterChangeApplied carries no progress, so without this frame the ring
    // stays on the pre-filter value until the next swipe.
    const frames = alice.sendRaw.mock.calls
      .map(([raw]) => JSON.parse(raw as string))
      .filter((m) => m.type === 'userProgress');
    expect(frames).toHaveLength(1);
    expect(frames[0].payload.progress).toBe(1); // 1 rated of 1 remaining title
  });
});

// ---------------------------------------------------------------------------

describe('Room identity cap', () => {
  it('ignores a rating from a new user once the room is tracking too many', async () => {
    const room = makeRoom();
    await room.media;
    room.notifyMatch = vi.fn();

    for (let i = 0; i < 500; i += 1) room.userProgress.set(`u${i}`, 1);

    await room.storeRating('stranger', like('m1'), Date.now());
    expect(room.userProgress.has('stranger')).toBe(false);
    expect(room.ratings.has('m1')).toBe(false);
    expect(room.userRated.has('stranger')).toBe(false);
  });

  it('still accepts ratings from identities the room already tracks', async () => {
    const room = makeRoom();
    await room.media;
    room.notifyMatch = vi.fn();

    for (let i = 0; i < 500; i += 1) room.userProgress.set(`u${i}`, 1);

    await room.storeRating('u0', like('m1'), Date.now());
    expect(room.userProgress.get('u0')).toBe(2);
    expect(room.ratings.get('m1')).toHaveLength(1);
  });

  it('does not let a refused rating refresh the room TTL', async () => {
    const room = makeRoom();
    await room.media;
    for (let i = 0; i < 500; i += 1) room.userProgress.set(`u${i}`, 1);

    const before = room.lastSwipeAt;
    await room.storeRating('stranger', like('m1'), before + 60_000);
    expect(room.lastSwipeAt).toBe(before);
  });
});

// ---------------------------------------------------------------------------

/**
 * Room whose getMedia parks every call after the first, so two applyFilters can
 * genuinely overlap. The 3s cooldown does not prevent the overlap: a slow Plex
 * fetch outlives it.
 */
const makeGatedRoom = () => {
  const queue: Array<{
    resolve: (media: Media[]) => void;
    reject: (err: unknown) => void;
  }> = [];
  let servedInitial = false;
  const ctx = {
    providers: [
      {
        getMedia: async (): Promise<Media[]> => {
          if (!servedInitial) {
            servedInitial = true;
            return ALL_MEDIA as unknown as Media[];
          }
          return new Promise<Media[]>((resolve, reject) => {
            queue.push({ resolve, reject });
          });
        },
      },
    ],
  } as unknown as RouteContext;
  return { room: new Room({ roomName: 'r', displayName: 'r' }, ctx), queue };
};

/** Turn microtasks until the parked getMedia calls have registered. */
const settle = async () => {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
};

describe('Room.applyFilters sequencing', () => {
  it('lets an earlier in-flight apply commit after a later one fails', async () => {
    const { room, queue } = makeGatedRoom();
    await room.media;

    const first = room.applyFilters([{ key: 'title', operator: '=', value: ['Film One'] }]);
    await settle();
    const second = room.applyFilters([{ key: 'title', operator: '=', value: ['Nothing'] }]);
    await settle();
    expect(queue).toHaveLength(2);

    // Attach the handler before rejecting so the failure is never unhandled.
    const secondResult = second.catch((err: unknown) => err);
    queue[1].reject(new NoMediaError('There are no items with the specified filters applied.'));
    expect(await secondResult).toBeInstanceOf(NoMediaError);

    queue[0].resolve([ALL_MEDIA[0]] as unknown as Media[]);
    // A failed apply that keeps the sequence number supersedes this one, which
    // then returns null and, because the caller reads null as "stay quiet",
    // leaves its user with no deck change and no error at all.
    await expect(first).resolves.not.toBeNull();
    expect(room.filters?.[0].value).toEqual(['Film One']);
    expect(await room.getMediaForUser('nobody')).toHaveLength(1);
  });

  it('still discards an apply superseded by one that commits', async () => {
    const { room, queue } = makeGatedRoom();
    await room.media;

    const first = room.applyFilters([{ key: 'title', operator: '=', value: ['Film One'] }]);
    await settle();
    const second = room.applyFilters([{ key: 'title', operator: '=', value: ['Film Two'] }]);
    await settle();

    queue[1].resolve([ALL_MEDIA[1]] as unknown as Media[]);
    await expect(second).resolves.toHaveLength(1);
    queue[0].resolve([ALL_MEDIA[0]] as unknown as Media[]);
    await expect(first).resolves.toBeNull();
    expect(room.filters?.[0].value).toEqual(['Film Two']);
  });
});
