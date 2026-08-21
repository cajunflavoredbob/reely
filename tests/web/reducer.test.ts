import { describe, it, expect } from 'vitest';
import { reducer, initialState } from '../../web/app/src/store/reducer';
import type { Actions, Store } from '../../web/app/src/store/types';
import { makeMedia } from '../helpers';

// Build a Store with a joined room carrying the given user list.
const withUsers = (users: NonNullable<Store['room']>['users']): Store => ({
  ...initialState,
  room: { name: 'movie-night', joined: true, mediaVersion: 0, users },
});

const joined = (userName: string, progress: number): Actions => ({
  type: 'userJoinedRoom',
  payload: { user: { userName }, progress },
});

describe('reducer userJoinedRoom', () => {
  it('appends a newly joined user', () => {
    const next = reducer(withUsers([]), joined('alice', 0));
    expect(next.room?.users).toEqual([{ user: { userName: 'alice' }, progress: 0 }]);
  });

  // A rejoining user broadcasts userJoinedRoom again; a blind append shows
  // them twice in everyone else's list.
  it('does not duplicate a user who rejoins', () => {
    const start = withUsers([{ user: { userName: 'alice' }, progress: 0.4 }]);
    const next = reducer(start, joined('alice', 0));
    expect(next.room?.users).toEqual([{ user: { userName: 'alice' }, progress: 0 }]);
  });

  it('keeps other users when one rejoins', () => {
    const start = withUsers([
      { user: { userName: 'alice' }, progress: 0.4 },
      { user: { userName: 'bob' }, progress: 0.2 },
    ]);
    const next = reducer(start, joined('alice', 0));
    expect(next.room?.users?.map((u) => u.user.userName).sort()).toEqual(['alice', 'bob']);
  });
});

describe('reducer mediaVersion (audit #14)', () => {
  const joinCycle = (state: Store): Store =>
    reducer(
      reducer(state, { type: 'joinRoom', payload: { roomName: 'r' } } as Actions),
      {
        type: 'joinRoomSuccess',
        payload: { roomName: 'r', media: [], users: [], previousMatches: [] },
      } as Actions,
    );

  // CardStack is keyed on mediaVersion and never re-renders otherwise, so the
  // counter must be monotonic: a reset to 0 collides across rejoins.
  it('assigns a fresh mediaVersion on every join so the CardStack key never collides', () => {
    const first = joinCycle(initialState);
    const second = joinCycle(first);
    expect(typeof first.room?.mediaVersion).toBe('number');
    expect(second.room?.mediaVersion).not.toBe(first.room?.mediaVersion);
  });
});

// Without a reducer case these errors fall through silently and the user gets
// no feedback at all.
describe('reducer error toasts', () => {
  it('filterChangeError surfaces the server message as a toast (#43)', () => {
    const next = reducer(initialState, {
      type: 'filterChangeError',
      payload: { message: 'Please wait a moment.' },
    } as Actions);
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0].message).toBe('Please wait a moment.');
  });

  // NOT_JOINED means the server already considers the user out, so treat it as
  // a successful leave. Toasting instead strands them on a dead room screen
  // after a failed silent rejoin. The toast branch stays for other errorTypes.
  it('leaveRoomError NOT_JOINED is treated as a successful leave', () => {
    const inRoom = {
      ...initialState,
      route: 'room',
      room: { name: 'movie-night' },
    } as unknown as Store;
    const next = reducer(inRoom, {
      type: 'leaveRoomError',
      payload: { errorType: 'NOT_JOINED' },
    } as Actions);
    expect(next.room).toBeUndefined();
    expect(next.route).toBe('login');
    expect(next.toasts).toHaveLength(0);
  });

  it('leaveRoomError with an unrecognized errorType still adds a toast (#70)', () => {
    const next = reducer(initialState, {
      type: 'leaveRoomError',
      payload: { errorType: 'SOMETHING_ELSE' },
    } as unknown as Actions);
    expect(next.toasts).toHaveLength(1);
  });

  it('logoutError adds a toast (#70)', () => {
    const next = reducer(initialState, {
      type: 'logoutError',
      payload: { name: 'NotLoggedIn', message: 'not logged in' },
    } as Actions);
    expect(next.toasts).toHaveLength(1);
  });

  // An error toast without showTimeMs stays pinned until the user clicks it.
  // The connection-failure toast is deliberately sticky and lives on the
  // updateConnectionStatus path instead.
  it.each([
    ['filterChangeError', { type: 'filterChangeError', payload: { message: 'no' } } as Actions],
    // NOT_JOINED no longer toasts, so use a hypothetical errorType.
    ['leaveRoomError', { type: 'leaveRoomError', payload: { errorType: 'OTHER' } } as unknown as Actions],
    ['logoutError', { type: 'logoutError', payload: { name: 'NotLoggedIn', message: '' } } as Actions],
    ['requestFiltersError', { type: 'requestFiltersError', payload: { message: 'fail' } } as Actions],
  ])('%s carries a showTimeMs', (_label, action) => {
    const next = reducer(initialState, action);
    expect(next.toasts[0].showTimeMs).toBeGreaterThan(0);
  });
});

// removeToast compares by id. An identity filter silently no-ops on any
// payload rebuilt from { id, message } rather than passed by reference.
describe('reducer removeToast', () => {
  const seeded: Store = {
    ...initialState,
    toasts: [
      { id: 'a', message: 'one' },
      { id: 'b', message: 'two' },
    ],
  };

  it('removes the matching toast by id', () => {
    const next = reducer(seeded, {
      type: 'removeToast',
      payload: { id: 'a', message: 'one' },
    } as Actions);
    expect(next.toasts.map((t) => t.id)).toEqual(['b']);
  });

  it('removes by id even when the payload is a fresh object (not reference-equal)', () => {
    // Same id, different object and message: an identity filter would miss it.
    const next = reducer(seeded, {
      type: 'removeToast',
      payload: { id: 'a', message: 'different text', appearance: 'Failure' },
    } as Actions);
    expect(next.toasts.map((t) => t.id)).toEqual(['b']);
  });
});

// Room events guard with `if (!state.room) return state;`. Without it, a
// server-contract violation delivering one to a roomless client throws a
// TypeError on the `state.room!` spread.
describe('reducer room-event guards', () => {
  it('userProgress returns state unchanged when no room is joined', () => {
    const next = reducer(initialState, {
      type: 'userProgress',
      payload: { user: { userName: 'alice' }, progress: 0.5 },
    } as Actions);
    expect(next).toBe(initialState);
  });

  it('userJoinedRoom returns state unchanged when no room is joined', () => {
    const next = reducer(initialState, {
      type: 'userJoinedRoom',
      payload: { user: { userName: 'alice' }, progress: 0 },
    } as Actions);
    expect(next).toBe(initialState);
  });

  it('userLeftRoom returns state unchanged when no room is joined', () => {
    const next = reducer(initialState, {
      type: 'userLeftRoom',
      payload: { userName: 'alice' },
    } as Actions);
    expect(next).toBe(initialState);
  });

  it('match returns state unchanged when no room is joined', () => {
    const next = reducer(initialState, {
      type: 'match',
      payload: {
        matchedAt: 1,
        media: makeMedia({ id: 'm1', title: 'X' }),
        users: ['alice', 'bob'],
      },
    } as Actions);
    expect(next).toBe(initialState);
  });
});

// toastCounter and mediaVersionCounter live in the Store, not module scope, so
// the reducer stays pure and each Store keeps its own. Both must be monotonic
// within a Store's lifetime and never reset.
describe('reducer counters in state', () => {
  it('initialState has toastCounter=0 + mediaVersionCounter=0', () => {
    expect(initialState.toastCounter).toBe(0);
    expect(initialState.mediaVersionCounter).toBe(0);
  });

  it('joinRoom increments mediaVersionCounter (and uses it for room.mediaVersion)', () => {
    const next = reducer(initialState, { type: 'joinRoom', payload: { roomName: 'r' } } as Actions);
    expect(next.mediaVersionCounter).toBe(1);
    expect(next.room?.mediaVersion).toBe(1);
  });

  it('joinRoomSuccess increments mediaVersionCounter again (so successful join gets a fresh key)', () => {
    const afterJoin = reducer(initialState, { type: 'joinRoom', payload: { roomName: 'r' } } as Actions);
    const afterSuccess = reducer(afterJoin, {
      type: 'joinRoomSuccess',
      payload: { roomName: 'r', media: [], users: [], previousMatches: [] },
    } as Actions);
    expect(afterSuccess.mediaVersionCounter).toBe(2);
    expect(afterSuccess.room?.mediaVersion).toBe(2);
  });

  it('toastCounter increments on a toast-emitting action (filterChangeError)', () => {
    const next = reducer(initialState, {
      type: 'filterChangeError',
      payload: { message: 'no' },
    } as Actions);
    expect(next.toastCounter).toBe(1);
    expect(next.toasts).toHaveLength(1);
    // Ids are `toast-{counter}-{random}`.
    expect(next.toasts[0].id).toMatch(/^toast-1-/);
  });

  it('toastCounter does NOT increment on actions that do not mint a toast', () => {
    const next = reducer(initialState, { type: 'navigate', payload: { route: 'login' } } as Actions);
    expect(next.toastCounter).toBe(0);
  });

  // A self-apply doesn't toast: you already know what you did.
  it('filterChangeApplied bumps mediaVersionCounter always but toastCounter only on other-user applies', () => {
    const seeded: Store = {
      ...initialState,
      user: { userName: 'alice' },
      room: { name: 'r', joined: true, mediaVersion: 5 },
      mediaVersionCounter: 5,
    };
    // Self-apply: toastCounter holds.
    const selfApply = reducer(seeded, {
      type: 'filterChangeApplied',
      payload: { appliedBy: 'alice', media: [], filters: [] },
    } as Actions);
    expect(selfApply.mediaVersionCounter).toBe(6);
    expect(selfApply.toastCounter).toBe(0);
    expect(selfApply.toasts).toHaveLength(0);
    // Other-user apply: BOTH bump.
    const otherApply = reducer(seeded, {
      type: 'filterChangeApplied',
      payload: { appliedBy: 'bob', media: [], filters: [] },
    } as Actions);
    expect(otherApply.mediaVersionCounter).toBe(6);
    expect(otherApply.toastCounter).toBe(1);
    expect(otherApply.toasts).toHaveLength(1);
  });

  it('counters thread monotonically across a sequence of actions', () => {
    let s: Store = initialState;
    // Two consecutive join-success cycles + a leaveRoomError toast.
    s = reducer(s, { type: 'joinRoom', payload: { roomName: 'r1' } } as Actions);
    s = reducer(s, {
      type: 'joinRoomSuccess',
      payload: { roomName: 'r1', media: [], users: [], previousMatches: [] },
    } as Actions);
    s = reducer(s, { type: 'joinRoom', payload: { roomName: 'r2' } } as Actions);
    s = reducer(s, {
      type: 'joinRoomSuccess',
      payload: { roomName: 'r2', media: [], users: [], previousMatches: [] },
    } as Actions);
    // logoutError still toasts; leaveRoomError NOT_JOINED navigates instead.
    s = reducer(s, { type: 'logoutError', payload: { name: 'NotLoggedIn', message: '' } } as Actions);
    // 4 mediaVersion bumps (2 per cycle).
    expect(s.mediaVersionCounter).toBe(4);
    // 1 toast bump.
    expect(s.toastCounter).toBe(1);
  });

  // Module-scope counters would make the second run continue the first's
  // trajectory instead of repeating it.
  it('two independent Store sequences produce identical counter trajectories (no cross-Store leak)', () => {
    const run = () => {
      let s: Store = initialState;
      s = reducer(s, { type: 'joinRoom', payload: { roomName: 'r' } } as Actions);
      s = reducer(s, { type: 'filterChangeError', payload: { message: 'x' } } as Actions);
      return { tc: s.toastCounter, mv: s.mediaVersionCounter };
    };
    expect(run()).toEqual({ tc: 1, mv: 1 });
    expect(run()).toEqual({ tc: 1, mv: 1 });
  });

  // The random suffix keeps ids distinct even on a repeated counter; pinned so
  // a refactor cannot quietly drop it.
  it('toast ids follow the `toast-{counter}-{random}` shape', () => {
    let s: Store = initialState;
    s = reducer(s, { type: 'filterChangeError', payload: { message: 'one' } } as Actions);
    s = reducer(s, { type: 'filterChangeError', payload: { message: 'two' } } as Actions);
    expect(s.toasts[0].id).toMatch(/^toast-1-[a-z0-9]+$/);
    expect(s.toasts[1].id).toMatch(/^toast-2-[a-z0-9]+$/);
  });
});
