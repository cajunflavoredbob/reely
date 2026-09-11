import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ReelyClient is mocked wholesale; the socket itself is covered by
// tests/web/reelyClient.test.ts. An EventTarget so the store's
// addEventListener calls work, with vi.fn methods to assert dispatch routing.
const makeClientMock = () => {
  const client = new EventTarget() as EventTarget & Record<string, ReturnType<typeof vi.fn>>;
  for (const name of [
    'login', 'logout', 'createRoom', 'joinRoom', 'joinOrCreateRoom', 'leaveRoom',
    'rate', 'setLocale', 'requestFilters', 'requestFilterValues', 'applyFilters',
  ] as const) {
    // Resolved by default; a test swaps in mockRejectedValue to reach the
    // dispatch-catch path.
    client[name] = vi.fn().mockResolvedValue(undefined);
  }
  return client;
};

let clientMock: ReturnType<typeof makeClientMock>;
vi.mock('../../web/app/src/api/reely', () => ({
  // Returning an object from a constructor makes `new` yield that object, so
  // tests assert against the same instance the store binds listeners to. The
  // closure resolves at construction time, after beforeEach reassigns it.
  // biome-ignore lint/complexity/useArrowFunction: createStore calls `new ReelyClient()`, and arrows can't be constructed.
  ReelyClient: function () {
    return clientMock;
  },
}));

// None of these exist in the node test env, and the store reads them at module
// load and inside createStore().
const setupDomGlobals = (opts: {
  href?: string;
  userName?: string | null;
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
  vi.stubGlobal('history', { replaceState: vi.fn() });
  vi.stubGlobal('navigator', { language: 'en-US' });
  vi.stubGlobal('document', { title: 'Reely', body: { dataset: {} } });
};

const loadCreateStore = async () => {
  const mod = await import('../../web/app/src/store/createStore');
  return mod;
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

describe('createStore initial state', () => {
  it('applies "connecting" status as the first state update', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // Live lookup: useZustandStore is a `let` reassigned inside createStore,
    // so destructuring captures the pre-init undefined.
    const useZustandStore = mod.useZustandStore;
    expect(useZustandStore.getState().connectionStatus).toBe('connecting');
  });

  it('navigates straight to login when the URL has ?roomName but no userName is stored', async () => {
    setupDomGlobals({ href: 'https://reely.example.com/?roomName=movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    // Live lookup: useZustandStore is a `let` reassigned inside createStore,
    // so destructuring captures the pre-init undefined.
    const useZustandStore = mod.useZustandStore;
    expect(useZustandStore.getState().route).toBe('login');
  });

  it('does NOT pre-navigate to login when ?roomName is set but a userName is stored', async () => {
    setupDomGlobals({
      href: 'https://reely.example.com/?roomName=movie-night',
      userName: 'alice',
    });
    const mod = await loadCreateStore();
    mod.createStore();
    // Live lookup: useZustandStore is a `let` reassigned inside createStore,
    // so destructuring captures the pre-init undefined.
    const useZustandStore = mod.useZustandStore;
    // Stays on loading while the WS connects; auto-join waits for loginSuccess.
    expect(useZustandStore.getState().route).toBe('loading');
  });
});

describe('dispatchToClient routing', () => {
  // `default: never` enforces exhaustiveness at compile time, but a routing
  // typo (login calling client.logout()) still typechecks.
  const cases = [
    ['login', { userName: 'a' }],
    ['createRoom', { roomName: 'r' }],
    ['joinRoom', { roomName: 'r' }],
    ['joinOrCreateRoom', { roomName: 'r' }],
    ['rate', { mediaId: 'm', rating: 'like' }],
    ['setLocale', { language: 'en' }],
    ['requestFilterValues', { key: 'genre' }],
    ['applyFilters', { filters: [] }],
  ] as const;

  for (const [type, payload] of cases) {
    it(`routes "${type}" to ReelyClient.${type}`, async () => {
      const mod = await loadCreateStore();
      mod.createStore();
      // biome-ignore lint/suspicious/noExplicitAny: test action shape; reducer types not the point here.
      mod.useZustandStore.getState().dispatch({ type, payload } as any);
      expect(clientMock[type]).toHaveBeenCalledTimes(1);
      expect(clientMock[type]).toHaveBeenCalledWith(payload);
    });
  }

  it('routes "logout" / "leaveRoom" / "requestFilters" as no-arg calls', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // Live lookup: useZustandStore is a `let` reassigned inside createStore,
    // so destructuring captures the pre-init undefined.
    const useZustandStore = mod.useZustandStore;
    const { dispatch } = useZustandStore.getState();
    dispatch({ type: 'logout' });
    dispatch({ type: 'leaveRoom' });
    dispatch({ type: 'requestFilters' });
    expect(clientMock.logout).toHaveBeenCalledWith();
    expect(clientMock.leaveRoom).toHaveBeenCalledWith();
    expect(clientMock.requestFilters).toHaveBeenCalledWith();
  });

  it('does not forward UI-only actions (addToast / navigate) to the WS client', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // Live lookup: useZustandStore is a `let` reassigned inside createStore,
    // so destructuring captures the pre-init undefined.
    const useZustandStore = mod.useZustandStore;
    const { dispatch } = useZustandStore.getState();
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    dispatch({ type: 'addToast', payload: { id: 't', message: 'x', appearance: 'Success', showTimeMs: 1000 } } as any);
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    dispatch({ type: 'navigate', payload: { route: 'login' } } as any);
    for (const name of Object.keys(clientMock).filter((k) => typeof clientMock[k] === 'function')) {
      expect(clientMock[name]).not.toHaveBeenCalled();
    }
  });

  it('clears localStorage userName on logout dispatch', async () => {
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    // Live lookup: useZustandStore is a `let` reassigned inside createStore,
    // so destructuring captures the pre-init undefined.
    const useZustandStore = mod.useZustandStore;
    expect(localStorage.getItem('userName')).toBe('alice');
    useZustandStore.getState().dispatch({ type: 'logout' });
    expect(localStorage.getItem('userName')).toBeNull();
  });
});

describe('dispatch promise-rejection toast', () => {
  // A request rejection (timeout, or a mid-wait close) must surface as a toast
  // instead of hanging the UI on an unhandled rejection.
  it('adds a "server isn\'t responding" toast when a dispatched request rejects', async () => {
    clientMock.login = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    // Live lookup: useZustandStore is a `let` reassigned inside createStore,
    // so destructuring captures the pre-init undefined.
    const useZustandStore = mod.useZustandStore;
    useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'a' } });
    // Let the rejection settle.
    await new Promise((r) => setTimeout(r, 0));
    const toasts = useZustandStore.getState().toasts ?? [];
    expect(toasts.some((t) => t.message.includes("isn't responding"))).toBe(true);
  });

  // A wall-clock id collides for every request that rejects in the same
  // millisecond, and one close rejects every parked waiter at once: React then
  // sees duplicate keys and the group shares a single dismiss timer.
  it('mints rejection toast ids through the store counter, not a clock', async () => {
    clientMock.requestFilterValues = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    const { dispatch } = mod.useZustandStore.getState();
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    dispatch({ type: 'requestFilterValues', payload: { key: 'genre' } } as any);
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    dispatch({ type: 'requestFilterValues', payload: { key: 'year' } } as any);
    // Both rejections settle in the same macrotask, so Date.now() would match.
    await new Promise((r) => setTimeout(r, 0));
    const ids = mod.useZustandStore.getState().toasts.map((t) => t.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith('toast-'))).toBe(true);
  });

  // The room set optimistically on dispatch is what drives Login's "joining…"
  // CTA; no server reply is coming to clear it.
  it('clears the optimistic room when a join request rejects', async () => {
    clientMock.joinOrCreateRoom = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } } as any);
    expect(mod.useZustandStore.getState().room?.joined).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(mod.useZustandStore.getState().room).toBeUndefined();
  });

  // A 15s reply timeout is not a dead socket: the server can still answer, and
  // it has already put the user in the room. Without the recovery the late
  // success finds no room in state, the reducer discards it, and the user sits
  // on the login screen as a member of a room they can't see.
  it('recovers the room when a join reply lands after its own timeout', async () => {
    clientMock.joinOrCreateRoom = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } } as any);
    await new Promise((r) => setTimeout(r, 0));
    expect(mod.useZustandStore.getState().room).toBeUndefined();

    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [], previousMatches: [] } } as any,
    }));

    expect(mod.useZustandStore.getState().route).toBe('room');
    expect(mod.useZustandStore.getState().room?.joined).toBe(true);
    expect(mod.useZustandStore.getState().room?.name).toBe('movie-night');
  });

  // The reducer's "no room in state" guard still has to hold for a success
  // nobody asked for; only a request this client made and lost recovers.
  it('still ignores a join success with no request of ours behind it', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [], previousMatches: [] } } as any,
    }));
    expect(mod.useZustandStore.getState().room).toBeUndefined();
    expect(mod.useZustandStore.getState().route).not.toBe('room');
  });

  // Leaving is deliberate: a reply still in flight when the user walks out must
  // not drag them back in.
  it('does not recover the room once the user has left', async () => {
    clientMock.joinOrCreateRoom = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    mod.useZustandStore.getState().dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } } as any);
    await new Promise((r) => setTimeout(r, 0));
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'leaveRoomSuccess' } as any,
    }));
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'joinRoomSuccess', payload: { roomName: 'movie-night', media: [], users: [], previousMatches: [] } } as any,
    }));
    expect(mod.useZustandStore.getState().room).toBeUndefined();
  });

  it('leaves the room in place when the rejecting request was not a join', async () => {
    clientMock.applyFilters = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    const { dispatch } = mod.useZustandStore.getState();
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    dispatch({ type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } } as any);
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    dispatch({ type: 'applyFilters', payload: { filters: [] } } as any);
    await new Promise((r) => setTimeout(r, 0));
    expect(mod.useZustandStore.getState().room).toBeDefined();
  });

  it('does NOT add a toast when fire-and-forget dispatches resolve cleanly', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // Live lookup: useZustandStore is a `let` reassigned inside createStore,
    // so destructuring captures the pre-init undefined.
    const useZustandStore = mod.useZustandStore;
    useZustandStore.getState().dispatch({ type: 'rate', payload: { mediaId: 'm', rating: 'like' } });
    await new Promise((r) => setTimeout(r, 0));
    const toasts = useZustandStore.getState().toasts ?? [];
    expect(toasts.length).toBe(0);
  });
});

describe('loading-escape timer', () => {
  it('navigates to login if still on the loading route 5s after createStore', async () => {
    vi.useFakeTimers();
    const mod = await loadCreateStore();
    mod.createStore();
    // Live lookup: useZustandStore is a `let` reassigned inside createStore,
    // so destructuring captures the pre-init undefined.
    const useZustandStore = mod.useZustandStore;
    expect(useZustandStore.getState().route).toBe('loading');
    vi.advanceTimersByTime(5_001);
    expect(useZustandStore.getState().route).toBe('login');
  });

  it('does NOT navigate if the route has already moved off "loading"', async () => {
    vi.useFakeTimers();
    const mod = await loadCreateStore();
    mod.createStore();
    // Live lookup: useZustandStore is a `let` reassigned inside createStore,
    // so destructuring captures the pre-init undefined.
    const useZustandStore = mod.useZustandStore;
    // The timer guards on `route === 'loading'`, so move off it first.
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    useZustandStore.getState().dispatch({ type: 'navigate', payload: { route: 'room' } } as any);
    vi.advanceTimersByTime(5_001);
    expect(useZustandStore.getState().route).toBe('room');
  });

  it('is cleared by signal abort (HMR cycle)', async () => {
    vi.useFakeTimers();
    const mod = await loadCreateStore();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    mod.createStore();
    // Assert on the handle, not on state: both stores' timers run the same
    // callback against the module-level `useZustandStore` export, so a leaked
    // first timer mutates the SECOND store and is invisible in any route.
    const escapeIndex = setTimeoutSpy.mock.calls.findIndex((call) => call[1] === 5000);
    const escapeTimer = setTimeoutSpy.mock.results[escapeIndex]?.value;
    expect(escapeTimer).toBeDefined();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    // The second call aborts the first's controller, which fires the listener.
    mod.createStore();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(escapeTimer);
  });

  // The URL's room belongs to the boot path. Once the timer hands control to
  // the login form the user picks their own, and a surviving pendingRoomJoin
  // fires a second join that creates a room nobody asked for.
  it('drops the URL auto-join when it hands over to the login form', async () => {
    vi.useFakeTimers();
    setupDomGlobals({
      href: 'https://reely.example.com/?roomName=movie-night',
      userName: 'alice',
    });
    const mod = await loadCreateStore();
    mod.createStore();
    vi.advanceTimersByTime(5_001);
    expect(mod.useZustandStore.getState().route).toBe('login');
    clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }));
    expect(clientMock.joinOrCreateRoom).not.toHaveBeenCalled();
  });
});

// localStorage THROWS rather than returning null when the browser blocks site
// data. createStore runs before React mounts and there is no error boundary
// above it, so an unguarded read is a blank page on a share link and a spinner
// that never resolves otherwise.
describe('blocked localStorage', () => {
  const blockStorage = () => {
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.stubGlobal('localStorage', {
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
    });
  };

  it('still reaches the login screen on a share link', async () => {
    setupDomGlobals({ href: 'https://reely.example.com/?roomName=movie-night' });
    blockStorage();
    const mod = await loadCreateStore();
    expect(() => mod.createStore()).not.toThrow();
    expect(mod.useZustandStore.getState().route).toBe('login');
  });

  it('survives the connected handler and a loginSuccess write', async () => {
    setupDomGlobals();
    blockStorage();
    const mod = await loadCreateStore();
    mod.createStore();
    expect(() => clientMock.dispatchEvent(new Event('connected'))).not.toThrow();
    expect(mod.useZustandStore.getState().route).toBe('login');
    expect(() => clientMock.dispatchEvent(new MessageEvent('message', {
      // biome-ignore lint/suspicious/noExplicitAny: message payload shape.
      data: { type: 'loginSuccess', payload: { userName: 'alice' } } as any,
    }))).not.toThrow();
    expect(mod.useZustandStore.getState().user).toEqual({ userName: 'alice' });
  });
});

describe('AbortController teardown across HMR', () => {
  it("removes the first call's listeners when createStore is invoked a second time", async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // EventTarget exposes no listener count, so count the calls one event
    // produces: one bind means one setLocale.
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.setLocale).toHaveBeenCalledTimes(1);
  });
});
