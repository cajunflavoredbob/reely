import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A controllable WebSocket double. The real ReelyClient creates `new WebSocket(...)`
// inside its constructor and again inside its private reconnect path, so the test
// needs to capture each socket instance and drive its open/close/message events
// from the outside. `instances` is the bridge: every `new MockWebSocket(...)` pushes
// itself onto it, and `latest()` returns the one ReelyClient is currently bound to.
class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static latest(): MockWebSocket {
    const last = MockWebSocket.instances.at(-1);
    if (!last) throw new Error('no MockWebSocket has been constructed yet');
    return last;
  }
  static reset() {
    MockWebSocket.instances = [];
  }

  readyState = MockWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.simulateClose();
  }
  // Test-side drivers (named `simulate*` so the test reads as a script of events).
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  simulateMessage(payload: unknown) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
  simulateError() {
    this.dispatchEvent(new Event('error'));
  }
}

// API_URL is computed at module-load time from `location.href` and
// `document.body.dataset.rootPath`. Stub both before importing the module
// so the URL parses cleanly and we can also assert what it resolved to.
const setupDomGlobals = (rootPath = '') => {
  vi.stubGlobal('location', { href: 'https://reely.example.com:8000/app/' });
  vi.stubGlobal('document', { body: { dataset: { rootPath } } });
};

// Lazy import the module AFTER globals are stubbed. Each test that wants a
// different rootPath / location must call vi.resetModules() first.
const loadClient = async () => {
  const mod = await import('../../web/app/src/api/reely');
  return mod.ReelyClient;
};

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  setupDomGlobals('');
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('API_URL', () => {
  it('upgrades https -> wss and appends /api/ws under the rootPath', async () => {
    setupDomGlobals('/reely');
    vi.resetModules();
    const ReelyClient = await loadClient();
    new ReelyClient();
    expect(MockWebSocket.latest().url).toBe('wss://reely.example.com:8000/reely/api/ws');
  });

  it('uses ws:// when the page is plain http', async () => {
    vi.stubGlobal('location', { href: 'http://reely.local/' });
    vi.resetModules();
    const ReelyClient = await loadClient();
    new ReelyClient();
    expect(MockWebSocket.latest().url.startsWith('ws://')).toBe(true);
  });

  it('strips query params so page params are not carried into the WS URL', async () => {
    vi.stubGlobal('location', { href: 'https://reely.example.com/?debug=1' });
    vi.resetModules();
    const ReelyClient = await loadClient();
    new ReelyClient();
    expect(MockWebSocket.latest().url).not.toContain('debug=1');
  });
});

describe('handleMessage shape-guard (audit 13 #311)', () => {
  it('dispatches the message under its `type` and the generic "message"', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    const typed = vi.fn();
    const generic = vi.fn();
    client.addEventListener('loginSuccess', typed);
    client.addEventListener('message', generic);
    MockWebSocket.latest().simulateMessage({ type: 'loginSuccess', payload: {} });
    expect(typed).toHaveBeenCalledTimes(1);
    expect(generic).toHaveBeenCalledTimes(1);
  });

  it('drops null frames without dispatching', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const heard = vi.fn();
    client.addEventListener('message', heard);
    MockWebSocket.latest().simulateMessage('null');
    expect(heard).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('drops frames whose `type` is not a string', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const heard = vi.fn();
    client.addEventListener('message', heard);
    MockWebSocket.latest().simulateMessage({ type: 42 });
    expect(heard).not.toHaveBeenCalled();
  });

  it('drops frames that fail JSON.parse without throwing', async () => {
    const ReelyClient = await loadClient();
    new ReelyClient();
    expect(() => MockWebSocket.latest().simulateMessage('not-json')).not.toThrow();
    expect(console.error).toHaveBeenCalled();
  });
});

describe('waitForConnected', () => {
  it('resolves immediately when the socket is already open', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    await expect(client.waitForConnected()).resolves.toBe(true);
  });

  it('waits for the "connected" event when the socket is still connecting', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const promise = client.waitForConnected();
    MockWebSocket.latest().simulateOpen();
    await expect(promise).resolves.toBe(true);
  });

  // Why a separate "connected" event instead of waiting on the socket's "open":
  // mid-reconnect the dead socket would never fire open, so we listen on the
  // client instead which survives the swap (comment in source).
  it('still resolves after a reconnect cycle (close -> connect -> open)', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateClose();
    const promise = client.waitForConnected();
    vi.advanceTimersByTime(2_000); // wake the scheduled reconnect
    MockWebSocket.latest().simulateOpen();
    await expect(promise).resolves.toBe(true);
  });
});

describe('waitForAnyMessage', () => {
  it('resolves on the first matching message type', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    const promise = client.waitForAnyMessage(['loginSuccess', 'loginError']);
    MockWebSocket.latest().simulateMessage({ type: 'loginSuccess', payload: {} });
    await expect(promise).resolves.toMatchObject({ type: 'loginSuccess' });
  });

  it('rejects when the socket closes mid-wait (audit 13 #312)', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    const promise = client.waitForAnyMessage(['loginSuccess', 'loginError']);
    MockWebSocket.latest().simulateClose();
    await expect(promise).rejects.toThrow(/Socket closed/);
  });

  it('rejects after REQUEST_TIMEOUT_MS without a reply', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    const promise = client.waitForAnyMessage(['loginSuccess']);
    // 15s is REQUEST_TIMEOUT_MS in the source.
    vi.advanceTimersByTime(15_001);
    await expect(promise).rejects.toThrow(/Timed out/);
  });

  // FilterPanel fires several requestFilterValues at once; the match predicate
  // correlates each response to its caller's key.
  it('uses the match predicate to route responses to the right caller', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    const genrePromise = client.waitForAnyMessage(
      ['requestFilterValuesSuccess'],
      (m) =>
        m.type === 'requestFilterValuesSuccess' && m.payload.request.key === 'genre',
    );
    // Wrong-key response: must NOT resolve genrePromise.
    MockWebSocket.latest().simulateMessage({
      type: 'requestFilterValuesSuccess',
      payload: { request: { key: 'year' }, values: [] },
    });
    // Right-key response.
    MockWebSocket.latest().simulateMessage({
      type: 'requestFilterValuesSuccess',
      payload: { request: { key: 'genre' }, values: ['Action'] },
    });
    const msg = await genrePromise;
    // biome-ignore lint/suspicious/noExplicitAny: discriminated-union payload narrowing not worth a generic in test code.
    expect((msg as any).payload.request.key).toBe('genre');
  });
});

describe('sendMessage + pendingRates', () => {
  it('forwards JSON when the socket is open', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();
    // biome-ignore lint/suspicious/noExplicitAny: test message shape; full ClientMessage narrowing not the point here.
    client.sendMessage({ type: 'login', payload: { userName: 'a' } } as any);
    const sent = MockWebSocket.latest().sent;
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? '{}').type).toBe('login');
  });

  it('queues `rate` messages when the socket is not open', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    // Socket still CONNECTING.
    // biome-ignore lint/suspicious/noExplicitAny: test message shape.
    client.sendMessage({ type: 'rate', payload: { mediaId: 'm', rating: 1 } } as any);
    expect(MockWebSocket.latest().sent).toHaveLength(0);
    // Open + flush is gated on join-success (handleOpen comment); the queue
    // is observable by triggering a join-success and watching it drain.
    MockWebSocket.latest().simulateOpen();
    MockWebSocket.latest().simulateMessage({ type: 'joinRoomSuccess', payload: {} });
    const sent = MockWebSocket.latest().sent;
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? '{}').type).toBe('rate');
  });

  it('drops non-rate messages when the socket is not open', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    // biome-ignore lint/suspicious/noExplicitAny: test message shape.
    client.sendMessage({ type: 'login', payload: { userName: 'a' } } as any);
    MockWebSocket.latest().simulateOpen();
    MockWebSocket.latest().simulateMessage({ type: 'joinRoomSuccess', payload: {} });
    expect(MockWebSocket.latest().sent).toHaveLength(0);
    expect(console.warn).toHaveBeenCalled();
  });

  it('caps pendingRates at MAX_PENDING_RATES (50), shifting the oldest off', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    for (let i = 0; i < 60; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: test message shape.
      client.sendMessage({ type: 'rate', payload: { mediaId: `m${i}`, rating: 1 } } as any);
    }
    MockWebSocket.latest().simulateOpen();
    MockWebSocket.latest().simulateMessage({ type: 'joinRoomSuccess', payload: {} });
    const sent = MockWebSocket.latest().sent;
    expect(sent).toHaveLength(50);
    // Oldest 10 were dropped, so the first surviving message is m10.
    expect(JSON.parse(sent[0] ?? '{}').payload.mediaId).toBe('m10');
  });

  // Audit 13 #286: a socket that re-closes mid-flush previously lost the tail.
  // Now any unsent remainder lands back on pendingRates in original order.
  it('re-queues the unsent tail when the socket closes mid-flush', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: test message shape.
      client.sendMessage({ type: 'rate', payload: { mediaId: `m${i}`, rating: 1 } } as any);
    }
    const ws = MockWebSocket.latest();
    // Intercept send: after 2 sends the socket "drops" -- simulating a close
    // partway through the flush loop.
    let sentCount = 0;
    ws.send = (data: string) => {
      ws.sent.push(data);
      sentCount++;
      if (sentCount === 2) ws.readyState = MockWebSocket.CLOSED;
    };
    ws.simulateOpen();
    ws.simulateMessage({ type: 'joinRoomSuccess', payload: {} });
    expect(ws.sent).toHaveLength(2);
    // Reconnect, rejoin: the surviving tail (m2, m3, m4) flushes in order.
    ws.simulateClose();
    vi.advanceTimersByTime(2_000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: {} });
    expect(ws2.sent.map((s) => JSON.parse(s).payload.mediaId)).toEqual(['m2', 'm3', 'm4']);
  });
});

describe('reconnect backoff', () => {
  it('schedules a reconnect after close', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    new ReelyClient();
    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.latest().simulateClose();
    // Base 500ms + up to 1s jitter. Advance well past the worst case.
    vi.advanceTimersByTime(2_000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('caps the backoff base at 30s even after many failed attempts', async () => {
    vi.useFakeTimers();
    // Pin jitter to 0 so we can assert the deterministic upper bound.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const ReelyClient = await loadClient();
    new ReelyClient();
    // Force the backoff counter high enough that 500 * 2^n would exceed 30s.
    for (let i = 0; i < 8; i++) {
      MockWebSocket.latest().simulateClose();
      vi.advanceTimersByTime(31_000);
    }
    const beforeCount = MockWebSocket.instances.length;
    MockWebSocket.latest().simulateClose();
    // Just under 30s: no new socket yet (proves cap is at least 30s, not above).
    vi.advanceTimersByTime(29_999);
    expect(MockWebSocket.instances.length).toBe(beforeCount);
    // Crossing 30s: the capped reconnect fires.
    vi.advanceTimersByTime(2);
    expect(MockWebSocket.instances.length).toBe(beforeCount + 1);
  });
});

describe('flushAfterRejoinHandler teardown (audit 11 #175 / audit 12 #213)', () => {
  // Two opens without an intervening join must NOT leave two flush listeners
  // installed; otherwise the eventual join-success would flush twice and the
  // listener set would grow across every reconnect-without-rejoin cycle.
  it('does not flush twice when two opens happen without a join in between', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    // biome-ignore lint/suspicious/noExplicitAny: test message shape.
    client.sendMessage({ type: 'rate', payload: { mediaId: 'm0', rating: 1 } } as any);

    // First open, then close before any join arrives.
    MockWebSocket.latest().simulateOpen();
    MockWebSocket.latest().simulateClose();
    vi.advanceTimersByTime(2_000);

    // Second open + join: must flush exactly once (one rate sent), not twice.
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: {} });
    expect(ws2.sent).toHaveLength(1);
  });
});

// Audit 16 #438: both production rate-storm defenses -- the 0.5.20
// pendingRates offline dedupe and the 0.5.22 sentRateIds online dedupe --
// shipped with "no test changes"; the pendingRates suite above drives
// sendMessage() directly, so rate() (the only production entry point) was
// never exercised. These pin the storm defenses through rate(), plus the
// audit 16 #429 room-affinity rules for the offline queue.
describe('rate() storm defenses (audit 16 #438 / 0.5.20 + 0.5.22)', () => {
  const ratesSent = (ws: MockWebSocket) =>
    ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'rate');

  it('sends a rate only once per mediaId over an open socket (sentRateIds)', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();
    await client.rate({ mediaId: 'm1', rating: 'like' });
    await client.rate({ mediaId: 'm1', rating: 'like' });
    await client.rate({ mediaId: 'm1', rating: 'dislike' });
    await client.rate({ mediaId: 'm2', rating: 'like' });
    const rates = ratesSent(ws);
    expect(rates).toHaveLength(2);
    expect(rates.map((r) => r.payload.mediaId)).toEqual(['m1', 'm2']);
  });

  it('joinRoom clears the dedup set so per-room ratings work (rate -> join -> rate)', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();
    await client.rate({ mediaId: 'm1', rating: 'like' });

    const joined = client.joinRoom({ roomName: 'movie-night' });
    // Let request()'s waitForConnected/waitForAnyMessage chain register
    // its listeners before the reply arrives.
    await new Promise((r) => setTimeout(r, 0));
    ws.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'movie-night' } });
    await joined;

    await client.rate({ mediaId: 'm1', rating: 'like' });
    expect(ratesSent(ws).filter((r) => r.payload.mediaId === 'm1')).toHaveLength(2);
  });

  it('a second offline rate for the same mediaId is dropped at the rate() boundary', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws1 = MockWebSocket.latest();
    ws1.simulateOpen();
    ws1.simulateClose();

    await client.rate({ mediaId: 'm1', rating: 'like' });
    await client.rate({ mediaId: 'm1', rating: 'dislike' });

    vi.advanceTimersByTime(2_000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: {} });
    // Exactly one queued rate flushes -- the storm scenario (a stuck client
    // looping rate dispatches while offline) can't fill the queue.
    expect(ratesSent(ws2)).toHaveLength(1);
  });

  it('a rate queued in room A does not flush into room B (audit 16 #429)', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws1 = MockWebSocket.latest();
    ws1.simulateOpen();
    // Establish room A as the current room (tags subsequent queued rates).
    ws1.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a' } });
    ws1.simulateClose();
    await client.rate({ mediaId: 'm1', rating: 'like' });

    vi.advanceTimersByTime(2_000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    // The user lands in a DIFFERENT room after the outage.
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-b' } });

    expect(ratesSent(ws2)).toHaveLength(0);
  });

  it('a rate queued in room A flushes when rejoining room A (audit 16 #429 control)', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws1 = MockWebSocket.latest();
    ws1.simulateOpen();
    ws1.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a' } });
    ws1.simulateClose();
    await client.rate({ mediaId: 'm1', rating: 'like' });

    vi.advanceTimersByTime(2_000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a' } });

    const rates = ratesSent(ws2);
    expect(rates).toHaveLength(1);
    expect(rates[0].payload.mediaId).toBe('m1');
  });

  it('leaveRoomSuccess clears the offline queue (audit 16 #429)', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws1 = MockWebSocket.latest();
    ws1.simulateOpen();
    ws1.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a' } });
    ws1.simulateClose();
    await client.rate({ mediaId: 'm1', rating: 'like' });

    vi.advanceTimersByTime(2_000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    // Server confirms a leave before any rejoin (e.g. a leave that raced
    // the disconnect): the queued rates belong to the ended session.
    ws2.simulateMessage({ type: 'leaveRoomSuccess', payload: {} });
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a' } });

    expect(ratesSent(ws2)).toHaveLength(0);
  });

  it('logoutSuccess clears the offline queue and dedup set (audit 16 #429)', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws1 = MockWebSocket.latest();
    ws1.simulateOpen();
    ws1.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a' } });
    await client.rate({ mediaId: 'm1', rating: 'like' });
    ws1.simulateClose();
    await client.rate({ mediaId: 'm2', rating: 'like' });

    vi.advanceTimersByTime(2_000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage({ type: 'logoutSuccess', payload: {} });
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a' } });

    // Queue cleared by logout: nothing flushes for the next user...
    expect(ratesSent(ws2)).toHaveLength(0);
    // ...and the dedup set was cleared too, so the next session can rate
    // the same media over the open socket.
    await client.rate({ mediaId: 'm1', rating: 'dislike' });
    expect(ratesSent(ws2)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('applyFilters wait is bounded and room-pinned', () => {
  it('gives up rather than parking forever while the socket is down', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    // Never opens. The bare waitForConnected never rejects and has no
    // timeout, so this used to park silently and fire minutes later.
    // Handler attached in the same tick the promise is created: the rejection
    // lands during the timer advance below, and an unhandled rejection makes
    // vitest exit non-zero even with every test green. Pinned to the reason
    // too, so an unrelated throw cannot satisfy it.
    const settled = client.applyFilters({ filters: [] }).then(
      () => 'resolved',
      (err: Error) => err.message,
    );

    await vi.advanceTimersByTimeAsync(20_000);

    expect(await settled).toMatch(/Not connected to the server/);
    expect(MockWebSocket.latest().sent.some((s) => s.includes('applyFilters'))).toBe(false);
  });

  it('does not deliver a queued apply into a different room', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws = MockWebSocket.latest();

    // Establish room A, then drop the socket and tap Apply there.
    ws.simulateOpen();
    const join = client.joinOrCreateRoom({ roomName: 'room-a' });
    await vi.advanceTimersByTimeAsync(0);
    ws.simulateMessage({
      type: 'joinRoomSuccess',
      payload: { roomName: 'room-a', displayName: 'room-a', media: [], users: [], previousMatches: [], filters: [] },
    });
    await join;
    ws.simulateClose();

    const settled = client.applyFilters({ filters: [] }).then(
      () => 'resolved',
      (err: Error) => err.message,
    );

    // They end up in room B by the time the socket comes back. The server's
    // membership gate would legitimately accept this, because the client IS a
    // live member of B -- so room A's filters would be applied to room B and
    // broadcast to everyone in it.
    await vi.advanceTimersByTimeAsync(5000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage({
      type: 'joinRoomSuccess',
      payload: { roomName: 'room-b', displayName: 'room-b', media: [], users: [], previousMatches: [], filters: [] },
    });
    await vi.advanceTimersByTimeAsync(0);

    // Rejects rather than resolving silently: handleApply closes the panel on
    // send, so a silent drop would leave the user staring at an unchanged deck
    // with no explanation. createStore turns the rejection into a toast.
    expect(await settled).toMatch(/room-a/);
    expect(MockWebSocket.latest().sent.some((f) => f.includes('applyFilters'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('rejoin flush keeps the rate dedup set', () => {
  const joinPayload = {
    roomName: 'room-a',
    displayName: 'room-a',
    media: [],
    users: [],
    previousMatches: [],
    filters: [],
  };

  it('re-records ids for rates it replays after a rejoin', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws = MockWebSocket.latest();

    ws.simulateOpen();
    const firstJoin = client.joinOrCreateRoom({ roomName: 'room-a' });
    await vi.advanceTimersByTimeAsync(0);
    ws.simulateMessage({ type: 'joinRoomSuccess', payload: joinPayload });
    await firstJoin;

    // Swipe while the socket is down, so the rate queues and records its id.
    ws.simulateClose();
    await client.rate({ mediaId: 'm1', rating: 'like' });

    // Reconnect and auto-rejoin. joinOrCreateRoom clears sentRateIds, and the
    // server built its deck BEFORE this rate landed, so the card comes back.
    await vi.advanceTimersByTimeAsync(5000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    const rejoin = client.joinOrCreateRoom({ roomName: 'room-a' });
    await vi.advanceTimersByTimeAsync(0);
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: joinPayload });
    await rejoin;
    await vi.advanceTimersByTimeAsync(0);

    const rateFrames = () => ws2.sent.filter((f) => f.includes('"type":"rate"'));
    const afterFlush = rateFrames().length;
    expect(afterFlush).toBeGreaterThan(0); // the queued rate really did flush

    // Re-swiping the same card must be suppressed. Without re-recording the id
    // during the flush it reaches the server, hits the already-rated branch,
    // and counts as neither a vote nor progress -- so the progress bar
    // silently disagrees with the card count.
    await client.rate({ mediaId: 'm1', rating: 'like' });
    expect(rateFrames().length).toBe(afterFlush);
  });
});

describe('UserFacingError tagging', () => {
  it('marks the cross-room applyFilters rejection as safe to display', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws = MockWebSocket.latest();

    ws.simulateOpen();
    const join = client.joinOrCreateRoom({ roomName: 'room-a' });
    await vi.advanceTimersByTimeAsync(0);
    ws.simulateMessage({
      type: 'joinRoomSuccess',
      payload: { roomName: 'room-a', displayName: 'room-a', media: [], users: [], previousMatches: [], filters: [] },
    });
    await join;
    ws.simulateClose();

    // The store decides whether to show a rejection verbatim by reading this
    // flag. Without it the user gets "The server isn't responding", which
    // blames the server for something the server never saw.
    const settled = client.applyFilters({ filters: [] }).then(
      () => undefined,
      (err: { userFacing?: unknown }) => err.userFacing,
    );

    await vi.advanceTimersByTimeAsync(5000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage({
      type: 'joinRoomSuccess',
      payload: { roomName: 'room-b', displayName: 'room-b', media: [], users: [], previousMatches: [], filters: [] },
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(await settled).toBe(true);
  });
});
