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
    mod.createStore();
    // Grab the first store before the re-call swaps the export, or the second
    // store's own 5s timer masks whether the first's was cleared.
    const firstStore = mod.useZustandStore;
    mod.createStore();
    vi.advanceTimersByTime(5_001);
    // Without abort + clearTimeout, the first timer navigates it to 'login'.
    expect(firstStore.getState().route).toBe('loading');
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
