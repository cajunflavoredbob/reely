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

  // Finding 2: a reconnecting/rejoining user broadcasts userJoinedRoom again.
  // A blind append showed that user twice in everyone else's list.
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

  // CardStack is keyed on mediaVersion and never re-renders otherwise. A
  // reset-to-0 collided across rejoins; the counter must be monotonic.
  it('assigns a fresh mediaVersion on every join so the CardStack key never collides', () => {
    const first = joinCycle(initialState);
    const second = joinCycle(first);
    expect(typeof first.room?.mediaVersion).toBe('number');
    expect(second.room?.mediaVersion).not.toBe(first.room?.mediaVersion);
  });
});

// #43 + #70: these error messages previously had no reducer case and fell
// through silently, leaving the user with no feedback.
describe('reducer error toasts', () => {
  it('filterChangeError surfaces the server message as a toast (#43)', () => {
    const next = reducer(initialState, {
      type: 'filterChangeError',
      payload: { message: 'Please wait a moment.' },
    } as Actions);
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0].message).toBe('Please wait a moment.');
  });

  // Audit 16 #452 changed NOT_JOINED semantics: the server already
  // considers the user out of any room, so the reducer treats it as a
  // successful leave (clear room, route to login) instead of toasting --
  // the toast-only handling left the user trapped on a dead room screen
  // after a failed silent rejoin. The toast branch remains for any
  // future errorType.
  it('leaveRoomError NOT_JOINED is treated as a successful leave (audit 16 #452)', () => {
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

  // Audit 12 #241: every error toast must carry showTimeMs so it auto-
  // dismisses. Prior cases shipped a toast with no TTL, which left it
  // pinned to the screen until the user clicked. The connection-failure
  // toast is intentionally sticky (cleared on reconnect) and isn't
  // covered here -- that's the `updateConnectionStatus` path.
  it.each([
    ['filterChangeError', { type: 'filterChangeError', payload: { message: 'no' } } as Actions],
    // NOT_JOINED no longer toasts (audit 16 #452); exercise the toast
    // branch with a hypothetical future errorType.
    ['leaveRoomError', { type: 'leaveRoomError', payload: { errorType: 'OTHER' } } as unknown as Actions],
    ['logoutError', { type: 'logoutError', payload: { name: 'NotLoggedIn', message: '' } } as Actions],
    ['requestFiltersError', { type: 'requestFiltersError', payload: { message: 'fail' } } as Actions],
  ])('%s carries a showTimeMs (audit 12 #241)', (_label, action) => {
    const next = reducer(initialState, action);
    expect(next.toasts[0].showTimeMs).toBeGreaterThan(0);
  });
});

// Audit 9 #103: removeToast filtered by object identity, so a dispatched
// payload that wasn't reference-equal to the stored toast (e.g. a fresh
// object rebuilt from { id, message }) silently no-op'd the removal. 0.4.3
// switched the filter to compare by id.
describe('reducer removeToast (audit 9 #103)', () => {
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
    // Construct a payload with the same id but a different object identity
    // and different message text -- the prior identity filter would have
    // failed to match and left the toast in state.
    const next = reducer(seeded, {
      type: 'removeToast',
      payload: { id: 'a', message: 'different text', appearance: 'Failure' },
    } as Actions);
    expect(next.toasts.map((t) => t.id)).toEqual(['b']);
  });
});

// Audit 9 #120: the prior room-event cases spread `state.room!` (non-null
// assertion). A server-contract violation that ever delivered one of these
// events to a roomless client would have thrown a runtime TypeError. 0.4.6
// guards with `if (!state.room) return state;` -- the action becomes a
// safe no-op instead.
describe('reducer room-event guards (audit 9 #120)', () => {
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

// Audit 13 #328 (landed 0.4.46): the module-scope toastCounter +
// mediaVersionCounter `let`s moved into the Store. The reducer is now
// pure -- each Store instance keeps its own counters. The invariant
// (monotonic within a Store's lifetime, never reset) still holds; it
// just lives explicitly in state instead of implicitly in the module.
describe('reducer counters in state (audit 13 #328)', () => {
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
    // Toast id contains the counter: `toast-{counter}-{random}`.
    expect(next.toasts[0].id).toMatch(/^toast-1-/);
  });

  it('toastCounter does NOT increment on actions that do not mint a toast', () => {
    const next = reducer(initialState, { type: 'navigate', payload: { route: 'login' } } as Actions);
    expect(next.toastCounter).toBe(0);
  });

  // filterChangeApplied bumps mediaVersionCounter always but only bumps
  // toastCounter when the apply came from a DIFFERENT user (self-apply
  // doesn't surface a toast -- you already know what you did).
  it('filterChangeApplied bumps mediaVersionCounter always but toastCounter only on other-user applies', () => {
    const seeded: Store = {
      ...initialState,
      user: { userName: 'alice' },
      room: { name: 'r', joined: true, mediaVersion: 5 },
      mediaVersionCounter: 5,
    };
    // Self-apply: toastCounter stays.
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
    // logoutError still toasts (leaveRoomError NOT_JOINED navigates
    // instead since audit 16 #452).
    s = reducer(s, { type: 'logoutError', payload: { name: 'NotLoggedIn', message: '' } } as Actions);
    // 4 mediaVersion bumps (2 per cycle).
    expect(s.mediaVersionCounter).toBe(4);
    // 1 toast bump.
    expect(s.toastCounter).toBe(1);
  });

  // Each Store keeps its OWN counters -- two parallel pseudo-stores never
  // share state. (Pre-#328 they did, via module-scope `let`.) Verified by
  // running the same action sequence against two independent initialStates
  // and asserting the results match exactly -- impossible under the
  // module-scope design.
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

  // Toast ids include the counter and a random suffix, so successive toasts
  // never collide on id even with the same counter (defensive). Pinning
  // the format so a future refactor doesn't drop the random component
  // without realizing.
  it('toast ids follow the `toast-{counter}-{random}` shape', () => {
    let s: Store = initialState;
    s = reducer(s, { type: 'filterChangeError', payload: { message: 'one' } } as Actions);
    s = reducer(s, { type: 'filterChangeError', payload: { message: 'two' } } as Actions);
    expect(s.toasts[0].id).toMatch(/^toast-1-[a-z0-9]+$/);
    expect(s.toasts[1].id).toMatch(/^toast-2-[a-z0-9]+$/);
  });
});
