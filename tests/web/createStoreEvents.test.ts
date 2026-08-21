import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Companion to createStore.test.ts, which covers init, dispatch and
// AbortController teardown. This one covers the connected / disconnected /
// message handlers.

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

// Captured per test so URL assertions don't re-read it through the global.
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

// Drive the store to route='room'. joinRoomSuccess only transitions when
// state.room already exists, so dispatch joinOrCreateRoom first.
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
    // A fresh createStore starts on route 'loading'.
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.login).toHaveBeenCalledWith({ userName: 'alice' });
  });

  // A reconnect must not pre-empt a user typing their identity on the login
  // screen with whatever cached userName localStorage happens to hold.
  it('does NOT auto-login when the route is "login" (stale-localStorage race guard, #301)', async () => {
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    // Move to the login route before 'connected' fires.
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
    // The escape timer's only side effect is navigate-to-login, fired at 5s
    // unless cleared. Route holding steady proves the clearTimeout ran.
    const routeBefore = mod.useZustandStore.getState().route;
    vi.advanceTimersByTime(5_001);
    const routeAfter = mod.useZustandStore.getState().route;
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

  // lastRoom lives in createStore's closure and is only observable through
  // path 1 below; here just check a non-room disconnect still applies status.
  it('still applies status when not in a room (no rejoin candidate captured)', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // route is 'loading', not 'room', so no lastRoom snapshot.
    clientMock.dispatchEvent(new Event('disconnected'));
    expect(mod.useZustandStore.getState().connectionStatus).toBe('disconnected');
  });
});

describe('message handler: loginSuccess paths', () => {
  // Path 1: reconnect while in a room, inside the 10-minute window. Rejoin
  // silently, or the reducer's loginSuccess clears room state and the user
  // sees an empty stack flash.
  it('path 1: silently rejoins the room on reconnect within the window', async () => {
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    // The lastRoom capture is gated on connectionStatus === 'connected', so a
    // live connection has to exist first.
    clientMock.dispatchEvent(new Event('connected'));
    enterRoom(mod, 'movie-night');
    expect(mod.useZustandStore.getState().route).toBe('room');

    // Disconnect captures lastRoom, then loginSuccess arrives on route 'room'.
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));

    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'movie-night' });
    // The reducer's loginSuccess case must not have cleared room state.
    expect(mod.useZustandStore.getState().room).toBeDefined();
    expect(mod.useZustandStore.getState().route).toBe('room');
  });

  it('path 1: outside the reconnect window, falls through (reducer clears room and routes to login)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected')); // arm the lastRoom capture
    enterRoom(mod, 'movie-night');

    clientMock.dispatchEvent(new Event('disconnected'));
    // Advance past RECONNECT_REJOIN_WINDOW_MS (10 minutes).
    vi.setSystemTime(11 * 60 * 1000);
    // Drop enterRoom's call; only the stale-window loginSuccess below matters.
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));

    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
    // The reducer's loginSuccess case ran instead.
    expect(mod.useZustandStore.getState().route).toBe('login');
    expect(mod.useZustandStore.getState().room).toBeUndefined();
  });

  // handleClose fires 'disconnected' for every failed reconnect attempt. If
  // each re-stamped lastRoom.at, the window would measure from the last
  // ATTEMPT rather than the drop and never expire while the tab kept retrying.
  it('path 1: failed reconnect attempts do not extend the rejoin window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    enterRoom(mod, 'movie-night');

    // Drop at t=0, then failing retries across the window, each firing
    // another 'disconnected'.
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

    // Measured from the original drop at t=0, long expired. A re-stamp would
    // rejoin silently, re-creating an empty room if the server TTL had lapsed.
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
    expect(mod.useZustandStore.getState().route).toBe('login');
    expect(mod.useZustandStore.getState().room).toBeUndefined();
  });

  it('path 1: surfaces a toast when the silent rejoin rejects', async () => {
    clientMock.joinOrCreateRoom = vi.fn().mockRejectedValue(new Error('room gone'));
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected')); // arm the lastRoom capture
    enterRoom(mod, 'movie-night');
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));
    // Let the rejection settle.
    await new Promise((r) => setTimeout(r, 0));
    const toasts = mod.useZustandStore.getState().toasts ?? [];
    expect(toasts.some((t) => t.message.includes("Couldn't rejoin"))).toBe(true);
  });

  // Path 2: not in a room, but ?roomName was on the URL at load. Skip the
  // login screen and auto-join.
  it('path 2: dispatches joinOrCreateRoom when pendingRoomJoin is set and user is not in a room', async () => {
    setupDomGlobals({
      href: 'https://reely.example.com/?roomName=movie-night',
      userName: 'alice',
    });
    const mod = await loadCreateStore();
    mod.createStore();
    // With userName and ?roomName both present, init stays on 'loading'.
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));
    expect(clientMock.joinOrCreateRoom).toHaveBeenCalledWith({ roomName: 'movie-night' });
  });

  // Path 3: no room, no pendingRoomJoin, so the reducer's loginSuccess takes
  // 'loading' to 'login'.
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

  // An explicit leave must drop the rejoin candidate, or a later reconnect
  // pulls the user back into the room they deliberately left.
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
    // Off route 'room' the disconnect captures nothing, and the leave already
    // wiped any candidate.
    clientMock.dispatchEvent(new Event('disconnected'));
    clientMock.joinOrCreateRoom.mockClear();
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
  });
});
