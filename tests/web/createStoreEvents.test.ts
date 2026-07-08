import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Companion to createStore.test.ts. That file covered init + dispatch +
// AbortController teardown (audit 13 #338 batch 0.4.29). This one covers
// the connected / disconnected / message event-handler paths -- the
// reactive surface of the store. Same mock harness; split into two
// files just to keep each focused and the diffs reviewable.

const makeClientMock = () => {
  const client = new EventTarget() as EventTarget & Record<string, ReturnType<typeof vi.fn>>;
  for (const name of [
    'login', 'logout', 'createRoom', 'joinRoom', 'joinOrCreateRoom', 'leaveRoom',
    'rate', 'setLocale', 'requestFilters', 'requestFilterValues', 'applyFilters',
  ] as const) {
    client[name] = vi.fn().mockResolvedValue(undefined);
  }
  return client;
};

let clientMock: ReturnType<typeof makeClientMock>;
vi.mock('../../web/app/src/api/reely', () => ({
  // biome-ignore lint/complexity/useArrowFunction: arrow functions can't be called with `new`, but createStore does `new ReelyClient()`. Function expression is required here.
  ReelyClient: function () {
    return clientMock;
  },
}));

// historyReplaceState is captured per test so we can assert on URL updates
// without re-reading the mock through the global. Cleared in beforeEach.
let historyReplaceState: ReturnType<typeof vi.fn>;

const setupDomGlobals = (opts: {
  href?: string;
  userName?: string | null;
  language?: string;
} = {}) => {
  const store = new Map<string, string>();
  if (opts.userName != null) store.set('userName', opts.userName);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  });
  vi.stubGlobal('location', {
    href: opts.href ?? 'https://reely.example.com/',
    search: opts.href ? new URL(opts.href).search : '',
  });
  historyReplaceState = vi.fn();
  vi.stubGlobal('history', { replaceState: historyReplaceState });
  vi.stubGlobal('navigator', { language: opts.language ?? 'en-US' });
  vi.stubGlobal('document', { title: 'Reely', body: { dataset: {} } });
};

const loadCreateStore = async () => {
  const mod = await import('../../web/app/src/store/createStore');
  return mod;
};

// Drive the store into route='room' state. The reducer's joinRoomSuccess
// case requires state.room to exist (set by the joinOrCreateRoom action)
// before it'll transition route='room'; this helper does both.
const enterRoom = (mod: Awaited<ReturnType<typeof loadCreateStore>>, roomName: string) => {
  // biome-ignore lint/suspicious/noExplicitAny: dispatched action shape; full Actions narrowing not the point in test setup.
  mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName } } as any);
  clientMock.dispatchEvent(new MessageEvent('message', {
    // biome-ignore lint/suspicious/noExplicitAny: ServerMessage payload shape; full discriminated-union narrowing not the point in test setup.
    data: { type: 'joinRoomSuccess', payload: { roomName, media: [], users: [], previousMatches: [] } } as any,
  }));
};

beforeEach(() => {
  clientMock = makeClientMock();
  setupDomGlobals();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connected handler', () => {
  it('applies "connected" connection status', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    expect(mod.useZustandStore.getState().connectionStatus).toBe('connected');
  });

  it('dispatches setLocale with navigator.language', async () => {
    setupDomGlobals({ language: 'fr-CA' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.setLocale).toHaveBeenCalledWith({ language: 'fr-CA' });
  });

  it('dispatches login with the stored userName when not on the login route', async () => {
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    // route starts as 'loading' on a fresh createStore.
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'alice' });
  });

  // Audit 13 #301: stale-localStorage race guard. If the user is actively
  // on the login screen typing their identity, an incoming reconnect must
  // NOT pre-empt with whatever cached userName happens to be in localStorage.
  it('does NOT auto-login when the route is "login" (stale-localStorage race guard, #301)', async () => {
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    // Move to login route before the 'connected' event fires.
    // biome-ignore lint/suspicious/noExplicitAny: navigate action shape.
    mod.useZustandStore.getState().dispatch({ type: 'navigate', payload: { route: 'login' } } as any);
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).not.toHaveBeenCalled();
  });

  it('navigates to login when no userName is stored', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    expect(mod.useZustandStore.getState().route).toBe('login');
    expect(clientMock.login).not.toHaveBeenCalled();
  });

  it('clears the loading-escape timer so the timer can\'t flip route a second time', async () => {
    vi.useFakeTimers();
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    // Connected sets route via the cached-userName login path; record it.
    // After 5s the loading-escape timer WOULD have re-flipped route to
    // 'login' if it had not been cleared (its check is route === 'loading').
    // We're not on 'loading' anymore (the connected branch dispatched
    // login -> reducer doesn't navigate from 'loading' until loginSuccess
    // arrives; route remains 'loading' here actually -- but the timer's
    // clearTimeout call is the point under test).
    //
    // Assert via the clearTimeout side-effect: advance 5s and verify the
    // timer callback did NOT cause a state-change toast or navigation
    // (its only side effect is navigate-to-login).
    const routeBefore = mod.useZustandStore.getState().route;
    vi.advanceTimersByTime(5_001);
    const routeAfter = mod.useZustandStore.getState().route;
    // Route should still match what 'connected' left it as -- the
    // escape-timer's navigate-to-login did NOT fire.
    expect(routeAfter).toBe(routeBefore);
  });
});

describe('disconnected handler', () => {
  it('applies "disconnected" connection status', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('disconnected'));
    expect(mod.useZustandStore.getState().connectionStatus).toBe('disconnected');
  });

  // The lastRoom snapshot is internal state inside createStore's closure;
  // observable only via its USE on the next loginSuccess (path 1 below).
  // Smoke test here: a disconnect outside the 'room' route should NOT
  // arm the silent-rejoin path. Proved indirectly via the path-1 test.
  it('still applies status when not in a room (no rejoin candidate captured)', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // route is 'loading' -- not 'room' -- so no lastRoom snapshot.
    clientMock.dispatchEvent(new Event('disconnected'));
    expect(mod.useZustandStore.getState().connectionStatus).toBe('disconnected');
  });
});

describe('message handler: loginSuccess paths (audit 13 #304)', () => {
  // Path 1: WS reconnect while the user was in a room AND within the
  // 10-minute reconnect window. Silently rejoin via client.joinOrCreateRoom
  // instead of letting the reducer's loginSuccess case clear room state
  // and flash an empty stack.
  it('path 1: silently rejoins the room on reconnect within the window', async () => {
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    // Establish a live connection first: the lastRoom capture is gated on
    // connectionStatus === 'connected' (audit 16 #428) so failed reconnect
    // attempts can't keep re-arming the rejoin window. In production a
    // user in a room always got there over a live connection.
    clientMock.dispatchEvent(new Event('connected'));
    enterRoom(mod, 'movie-night');
    expect(mod.useZustandStore.getState().route).toBe('room');

    // Reconnect cycle: disconnect captures lastRoom, then loginSuccess
    // arrives while route is still 'room'.
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));

    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'movie-night' });
    // Room state must NOT have been cleared by the reducer's loginSuccess case.
    expect(mod.useZustandStore.getState().room).toBeDefined();
    expect(mod.useZustandStore.getState().route).toBe('room');
  });

  it('path 1: outside the reconnect window, falls through (reducer clears room and routes to login)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected')); // arm the #428 capture gate
    enterRoom(mod, 'movie-night');

    clientMock.dispatchEvent(new Event('disconnected'));
    // Advance past RECONNECT_REJOIN_WINDOW_MS (10 minutes).
    vi.setSystemTime(11 * 60 * 1000);
    // Clear the call from enterRoom -- we only care about what happens
    // AFTER the stale-window loginSuccess arrives below.
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));

    // Silent-rejoin did NOT fire (joinOrCreateRoom never called by the handler).
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
    // Reducer's loginSuccess case ran: route -> 'login', room cleared.
    expect(mod.useZustandStore.getState().route).toBe('login');
    expect(mod.useZustandStore.getState().room).toBeUndefined();
  });

  // audit 16 #428: handleClose fires a 'disconnected' event for every
  // failed reconnect attempt during an outage, and each one used to
  // re-stamp lastRoom.at -- the rejoin window measured time since the
  // last ATTEMPT, not the drop, so it could never expire while the tab
  // kept retrying. The capture is now gated on a live connection.
  it('path 1: failed reconnect attempts do not extend the rejoin window (audit 16 #428)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    enterRoom(mod, 'movie-night');

    // The live connection drops at t=0; retries keep failing across the
    // 10-minute window, each close firing another 'disconnected'.
    clientMock.dispatchEvent(new Event('disconnected'));
    vi.setSystemTime(9 * 60 * 1000);
    clientMock.dispatchEvent(new Event('disconnected'));
    vi.setSystemTime(11 * 60 * 1000);
    clientMock.dispatchEvent(new Event('disconnected'));

    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));

    // The window is measured from the ORIGINAL drop (t=0), long expired.
    // Pre-#428, the 11-minute attempt re-stamped it and this silently
    // rejoined (re-creating the server-side room, empty, if it had
    // TTL-expired during the outage).
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
    expect(mod.useZustandStore.getState().route).toBe('login');
    expect(mod.useZustandStore.getState().room).toBeUndefined();
  });

  it('path 1: surfaces a toast when the silent rejoin rejects', async () => {
    clientMock.joinOrCreateRoom = vi.fn().mockRejectedValue(new Error('room gone'));
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected')); // arm the #428 capture gate
    enterRoom(mod, 'movie-night');
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));
    // Let the rejection microtask settle.
    await new Promise((r) => setTimeout(r, 0));
    const toasts = mod.useZustandStore.getState().toasts ?? [];
    expect(toasts.some((t) => t.message.includes("Couldn't rejoin"))).toBe(true);
  });

  // Path 2: not currently in a room, but the URL had ?roomName on initial
  // load. Skip the login screen and auto-join.
  it('path 2: dispatches joinOrCreateRoom when pendingRoomJoin is set and user is not in a room', async () => {
    setupDomGlobals({
      href: 'https://reely.example.com/?roomName=movie-night',
      userName: 'alice',
    });
    const mod = await loadCreateStore();
    mod.createStore();
    // route stays 'loading' on init (userName + ?roomName both present).
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'movie-night' });
  });

  // Path 3: no in-room, no pendingRoomJoin -> fall through to reducer.
  // The reducer's loginSuccess case from 'loading' route navigates to 'login'.
  it('path 3: falls through to the reducer when there\'s nothing special to do', async () => {
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
    expect(mod.useZustandStore.getState().user).toEqual({ userName: 'alice' });
    expect(mod.useZustandStore.getState().route).toBe('login');
  });

  it('persists userName to localStorage only when it\'s a non-empty string', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));
    expect(localStorage.getItem('userName')).toBe('alice');
  });

  it('does NOT persist a missing userName (the old `userName!` bug)', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed payload.
      data: { type: 'loginSuccess', payload: {} } as any,
    }));
    expect(localStorage.getItem('userName')).toBeNull();
  });
});

describe('message handler: URL syncing', () => {
  it('joinRoomSuccess writes ?roomName into the URL', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: dispatched action shape.
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } } as any);
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [], previousMatches: [] } } as any,
    }));
    expect(historyReplaceState).toHaveBeenCalled();
    const url = historyReplaceState.mock.calls[0]?.[2] as string;
    expect(url).toContain('roomName=movie-night');
  });

  it('createRoomSuccess writes ?roomName into the URL', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: dispatched action shape.
    mod.useZustandStore.getState().dispatch({ type: 'createRoom', payload: { roomName: 'new-room' } } as any);
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'createRoomSuccess', payload: { roomName: 'new-room', media: [], users: [], previousMatches: [] } } as any,
    }));
    expect(historyReplaceState).toHaveBeenCalled();
    const url = historyReplaceState.mock.calls[0]?.[2] as string;
    expect(url).toContain('roomName=new-room');
  });

  it('leaveRoomSuccess removes ?roomName from the URL', async () => {
    setupDomGlobals({ href: 'https://reely.example.com/?roomName=movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'leaveRoomSuccess' } as any,
    }));
    expect(historyReplaceState).toHaveBeenCalled();
    const url = historyReplaceState.mock.calls[0]?.[2] as string;
    expect(url).not.toContain('roomName');
  });

  it('logoutSuccess removes ?roomName from the URL', async () => {
    setupDomGlobals({ href: 'https://reely.example.com/?roomName=movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'logoutSuccess' } as any,
    }));
    expect(historyReplaceState).toHaveBeenCalled();
    const url = historyReplaceState.mock.calls[0]?.[2] as string;
    expect(url).not.toContain('roomName');
  });

  // Auto-rejoin candidate must be dropped on EXPLICIT leave/logout: the user
  // deliberately left, so a subsequent reconnect shouldn't silently pull them
  // back into the room they left.
  it('leaveRoomSuccess drops the silent-rejoin candidate so a later reconnect does NOT rejoin', async () => {
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    enterRoom(mod, 'movie-night');
    // User explicitly leaves.
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'leaveRoomSuccess' } as any,
    }));
    // Now a reconnect cycle: disconnect would NOT capture lastRoom because
    // route is no longer 'room'; even if it had, the leave above wiped it.
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
  });
});
