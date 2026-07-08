import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ReelyClient is mocked out wholesale: the store's WS dispatch / event
// wiring is what we want to assert here, not the underlying socket
// behavior (already covered by tests/web/reelyClient.test.ts). The mock
// is an EventTarget so the store's addEventListener calls work, and each
// method is a vi.fn so we can assert the routing in dispatchToClient.
const makeClientMock = () => {
  const client = new EventTarget() as EventTarget & Record<string, ReturnType<typeof vi.fn>>;
  for (const name of [
    'login', 'logout', 'createRoom', 'joinRoom', 'joinOrCreateRoom', 'leaveRoom',
    'rate', 'setLocale', 'requestFilters', 'requestFilterValues', 'applyFilters',
  ] as const) {
    // Default: every method returns a resolved Promise. Individual tests
    // can replace a method (e.g. with vi.fn().mockRejectedValue(...)) to
    // exercise the dispatch-catch path.
    client[name] = vi.fn().mockResolvedValue(undefined);
  }
  return client;
};

let clientMock: ReturnType<typeof makeClientMock>;
vi.mock('../../web/app/src/api/reely', () => ({
  // Constructor returns the shared mock so the test can assert against the
  // same instance the store binds its listeners to. When `new` calls a
  // function that returns an object, JS uses that object instead of the
  // freshly-allocated `this` (a legitimate constructor pattern). Note: must
  // be a function expression, not an arrow -- arrows can't be called with
  // `new`. The closure over `clientMock` is resolved at construction time,
  // not factory time, so beforeEach's re-assignment of clientMock is in
  // effect by the time createStore() runs.
  // biome-ignore lint/complexity/useArrowFunction: arrow functions can't be called with `new`, but createStore does `new ReelyClient()`. Function expression is required here.
  ReelyClient: function () {
    return clientMock;
  },
}));

// localStorage / location / history / navigator / document don't exist in
// the node test env. Each test sets them via stubs; the store reads them
// at module-load and inside the createStore() call.
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
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    expect(useZustandStore.getState().connectionStatus).toBe('connecting');
  });

  it('navigates straight to login when the URL has ?roomName but no userName is stored', async () => {
    setupDomGlobals({ href: 'https://reely.example.com/?roomName=movie-night' });
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
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
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    // Stays on the loading route while the WS connects -- the auto-join
    // happens on loginSuccess, not synchronously here.
    expect(useZustandStore.getState().route).toBe('loading');
  });
});

describe('dispatchToClient routing', () => {
  // One smoke test per ClientActions variant -- the switch's `default: never`
  // enforces exhaustiveness at compile time, but a routing typo (e.g. login
  // -> client.logout()) wouldn't fail typecheck. These tests pin the actual
  // method getting called per action type.
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
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
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
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    const { dispatch } = useZustandStore.getState();
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    dispatch({ type: 'addToast', payload: { id: 't', message: 'x', appearance: 'Success', showTimeMs: 1000 } } as any);
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    dispatch({ type: 'navigate', payload: { route: 'login' } } as any);
    // No WS method should fire for either.
    for (const name of Object.keys(clientMock).filter((k) => typeof clientMock[k] === 'function')) {
      expect(clientMock[name]).not.toHaveBeenCalled();
    }
  });

  it('clears localStorage userName on logout dispatch', async () => {
    setupDomGlobals({ userName: 'alice' });
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    expect(localStorage.getItem('userName')).toBe('alice');
    useZustandStore.getState().dispatch({ type: 'logout' });
    expect(localStorage.getItem('userName')).toBeNull();
  });
});

describe('dispatch promise-rejection toast (audit 12 #246)', () => {
  // A request method's rejection (REQUEST_TIMEOUT_MS in api/reely.ts, or a
  // mid-wait close) must surface as a toast instead of leaving the UI hung
  // on an unhandled rejection.
  it('adds a "server isn\'t responding" toast when a dispatched request rejects', async () => {
    clientMock.login = vi.fn().mockRejectedValue(new Error('timeout'));
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    useZustandStore.getState().dispatch({ type: 'login', payload: { userName: 'a' } });
    // Let the rejection microtask settle.
    await new Promise((r) => setTimeout(r, 0));
    const toasts = useZustandStore.getState().toasts ?? [];
    expect(toasts.some((t) => t.message.includes("isn't responding"))).toBe(true);
  });

  it('does NOT add a toast when fire-and-forget dispatches resolve cleanly', async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    useZustandStore.getState().dispatch({ type: 'rate', payload: { mediaId: 'm', rating: 'like' } });
    await new Promise((r) => setTimeout(r, 0));
    const toasts = useZustandStore.getState().toasts ?? [];
    expect(toasts.length).toBe(0);
  });
});

describe('loading-escape timer (audit 13 #303)', () => {
  it('navigates to login if still on the loading route 5s after createStore', async () => {
    vi.useFakeTimers();
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    expect(useZustandStore.getState().route).toBe('loading');
    vi.advanceTimersByTime(5_001);
    expect(useZustandStore.getState().route).toBe('login');
  });

  it('does NOT navigate if the route has already moved off "loading"', async () => {
    vi.useFakeTimers();
    const mod = await loadCreateStore();
    mod.createStore();
    // useZustandStore is a `let` export reassigned inside createStore;
    // destructuring would capture the pre-init `undefined`. Read it
    // through the module namespace instead so it's a live lookup.
    const useZustandStore = mod.useZustandStore;
    // Simulate something having navigated away first (the connected handler,
    // the user, etc.). The timer's check guards on `route === 'loading'`.
    // biome-ignore lint/suspicious/noExplicitAny: test action shape.
    useZustandStore.getState().dispatch({ type: 'navigate', payload: { route: 'room' } } as any);
    vi.advanceTimersByTime(5_001);
    expect(useZustandStore.getState().route).toBe('room');
  });

  it('is cleared by signal abort (HMR cycle)', async () => {
    vi.useFakeTimers();
    const mod = await loadCreateStore();
    mod.createStore();
    // Capture the FIRST store's handle BEFORE the re-call swaps the
    // exported binding. Without this, we'd be observing the second
    // store (whose own timer fires at 5s) and couldn't tell whether
    // the first's timer was actually cleared.
    const firstStore = mod.useZustandStore;
    mod.createStore();
    vi.advanceTimersByTime(5_001);
    // Without abort + clearTimeout, the first store's timer would have
    // navigated firstStore to 'login'. With it, firstStore stays put.
    expect(firstStore.getState().route).toBe('loading');
  });
});

describe('AbortController teardown across HMR (audit 13 #302 / audit 14 #365)', () => {
  it("removes the first call's listeners when createStore is invoked a second time", async () => {
    const mod = await loadCreateStore();
    mod.createStore();
    // EventTarget has no public listener-count API; observe behaviour
    // instead. Dispatch "connected" after a second createStore and
    // assert setLocale is called exactly once (one bind), not twice.
    mod.createStore();
    clientMock.dispatchEvent(new Event('connected'));
    expect(clientMock.setLocale).toHaveBeenCalledTimes(1);
  });
});
