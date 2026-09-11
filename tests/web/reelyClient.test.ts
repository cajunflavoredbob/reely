import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable WebSocket double. ReelyClient constructs a socket in its
// constructor and again on every reconnect, so tests need a handle on each:
// every construction pushes onto `instances`, and `latest()` is the bound one.
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
  // Test-side event drivers.
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

// API_URL is computed at module load from location.href and
// document.body.dataset.rootPath, so both must be stubbed before the import.
const setupDomGlobals = (rootPath = '') => {
  vi.stubGlobal('location', { href: 'https://reely.example.com:8000/app/' });
  vi.stubGlobal('document', { body: { dataset: { rootPath } } });
};

// Imports after the globals are stubbed. A different rootPath or location
// needs vi.resetModules() first.
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

describe('handleMessage shape-guard', () => {
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

  // The client emits "connected" rather than the test watching the socket's
  // "open": mid-reconnect the dead socket never fires open, and the client
  // survives the swap.
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

  it('rejects when the socket closes mid-wait', async () => {
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

  // FilterPanel fires several requestFilterValues at once, so the predicate
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
    // Wrong key: must not resolve genrePromise.
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
    // The flush is gated on join-success, so trigger one and watch it drain.
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

  // A socket that re-closes mid-flush must put the unsent remainder back on
  // pendingRates in original order instead of losing it.
  it('re-queues the unsent tail when the socket closes mid-flush', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: test message shape.
      client.sendMessage({ type: 'rate', payload: { mediaId: `m${i}`, rating: 1 } } as any);
    }
    const ws = MockWebSocket.latest();
    // After 2 sends the socket "drops", partway through the flush loop.
    let sentCount = 0;
    ws.send = (data: string) => {
      ws.sent.push(data);
      sentCount++;
      if (sentCount === 2) ws.readyState = MockWebSocket.CLOSED;
    };
    ws.simulateOpen();
    ws.simulateMessage({ type: 'joinRoomSuccess', payload: {} });
    expect(ws.sent).toHaveLength(2);
    // Reconnect and rejoin: the tail flushes in order.
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
    // Base 500ms plus up to 1s jitter; advance past the worst case.
    vi.advanceTimersByTime(2_000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('caps the backoff base at 30s even after many failed attempts', async () => {
    vi.useFakeTimers();
    // Jitter pinned to 0 for a deterministic bound.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const ReelyClient = await loadClient();
    new ReelyClient();
    // Push the backoff counter past where 500 * 2^n exceeds 30s.
    for (let i = 0; i < 8; i++) {
      MockWebSocket.latest().simulateClose();
      vi.advanceTimersByTime(31_000);
    }
    const beforeCount = MockWebSocket.instances.length;
    MockWebSocket.latest().simulateClose();
    // Just under 30s: no new socket, so the cap is not below 30s.
    vi.advanceTimersByTime(29_999);
    expect(MockWebSocket.instances.length).toBe(beforeCount);
    // Crossing 30s: the capped reconnect fires.
    vi.advanceTimersByTime(2);
    expect(MockWebSocket.instances.length).toBe(beforeCount + 1);
  });

  // The two tests above only ever escalate, so neither says anything about the
  // STABLE_CONNECTION_MS reset. These pin it from both sides: a connection that
  // proves stable clears the counter, and one that dies early must not.
  it('resets the backoff once a connection has stayed up past the stability window', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const ReelyClient = await loadClient();
    const client = new ReelyClient();

    // Escalate first, so a reset is actually observable.
    for (let i = 0; i < 3; i++) {
      MockWebSocket.latest().simulateClose();
      vi.advanceTimersByTime(31_000);
    }
    expect(client.reconnectionAttempts).toBe(3);

    // 10s is STABLE_CONNECTION_MS in the source.
    MockWebSocket.latest().simulateOpen();
    vi.advanceTimersByTime(10_001);
    expect(client.reconnectionAttempts).toBe(0);

    // So the next drop retries at the 500ms base, not the 30s cap.
    const before = MockWebSocket.instances.length;
    MockWebSocket.latest().simulateClose();
    vi.advanceTimersByTime(501);
    expect(MockWebSocket.instances.length).toBe(before + 1);
  });

  it('keeps escalating when a connection dies before it proves stable', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const ReelyClient = await loadClient();
    const client = new ReelyClient();

    // Accept-then-close crash loop: each socket opens and drops well inside the
    // stability window, so handleClose clears the reset timer before it fires.
    // Moving the reset into handleOpen makes every retry 500ms forever, which
    // is the condition the timer exists to prevent.
    MockWebSocket.latest().simulateOpen();
    vi.advanceTimersByTime(1_000);
    MockWebSocket.latest().simulateClose();
    expect(client.reconnectionAttempts).toBe(1);

    vi.advanceTimersByTime(501);
    MockWebSocket.latest().simulateOpen();
    vi.advanceTimersByTime(1_000);
    MockWebSocket.latest().simulateClose();
    expect(client.reconnectionAttempts).toBe(2);

    // Second delay doubled to 1s: nothing at 999ms, a new socket just past it.
    const before = MockWebSocket.instances.length;
    vi.advanceTimersByTime(999);
    expect(MockWebSocket.instances.length).toBe(before);
    vi.advanceTimersByTime(2);
    expect(MockWebSocket.instances.length).toBe(before + 1);
  });
});

describe('flushAfterRejoinHandler teardown', () => {
  // Two opens without a join between them must not leave two flush listeners
  // installed, or the eventual join-success flushes twice and the listener set
  // grows on every reconnect-without-rejoin cycle.
  it('does not flush twice when two opens happen without a join in between', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    // biome-ignore lint/suspicious/noExplicitAny: test message shape.
    client.sendMessage({ type: 'rate', payload: { mediaId: 'm0', rating: 1 } } as any);

    // Open, then close before any join arrives.
    MockWebSocket.latest().simulateOpen();
    MockWebSocket.latest().simulateClose();
    vi.advanceTimersByTime(2_000);

    // Second open plus join: exactly one rate sent.
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: {} });
    expect(ws2.sent).toHaveLength(1);
  });
});

// The pendingRates suite above drives sendMessage() directly, leaving rate()
// (the only production entry point) unexercised. These pin both storm defenses
// through rate() itself, plus the room-affinity rules for the offline queue.
describe('rate() storm defenses', () => {
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
    // Let request()'s waitForConnected/waitForAnyMessage chain register its
    // listeners before the reply arrives.
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
    // One queued rate flushes, so a stuck client looping rate dispatches while
    // offline cannot fill the queue.
    expect(ratesSent(ws2)).toHaveLength(1);
  });

  it('a rate queued in room A does not flush into room B', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws1 = MockWebSocket.latest();
    ws1.simulateOpen();
    // Room A becomes current, tagging the queued rates that follow.
    ws1.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a' } });
    ws1.simulateClose();
    await client.rate({ mediaId: 'm1', rating: 'like' });

    vi.advanceTimersByTime(2_000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    // The user lands in a different room after the outage.
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-b' } });

    expect(ratesSent(ws2)).toHaveLength(0);
  });

  it('a rate queued in room A flushes when rejoining room A', async () => {
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

  // Room affinity is a name, and the server recycles names: an idle room is
  // destroyed after its 6h TTL and the next join under that name builds a new
  // one. A queued vote older than the age bound therefore proves nothing about
  // where it would land, so it is discarded rather than replayed.
  it('drops a queued rate that outlived the staleness bound', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws1 = MockWebSocket.latest();
    ws1.simulateOpen();
    ws1.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a' } });
    ws1.simulateClose();
    await client.rate({ mediaId: 'm1', rating: 'like' });

    // A phone that lost signal overnight, reconnecting hours later.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1_000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a' } });

    expect(ratesSent(ws2)).toHaveLength(0);
  });

  it('leaveRoomSuccess clears the offline queue', async () => {
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
    // A leave that raced the disconnect: the queued rates belong to the
    // session that just ended.
    ws2.simulateMessage({ type: 'leaveRoomSuccess', payload: {} });
    ws2.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a' } });

    expect(ratesSent(ws2)).toHaveLength(0);
  });

  it('logoutSuccess clears the offline queue and dedup set', async () => {
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

    // Queue cleared, so nothing flushes for the next user.
    expect(ratesSent(ws2)).toHaveLength(0);
    // Dedup set cleared too, so the next session can rate the same media.
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
    // Never opens. A bare waitForConnected has no timeout and never rejects,
    // so the apply parks silently and fires minutes later.
    // The handler attaches in the same tick the promise is created: the
    // rejection lands during the timer advance below, and an unhandled
    // rejection makes vitest exit non-zero even with every test green. Matched
    // on the reason so an unrelated throw cannot satisfy it.
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

    // Room A, then drop the socket and tap Apply there.
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

    // They are in room B when the socket returns. The server's membership gate
    // would accept the apply, since the client really is a member of B, and
    // room A's filters would land on room B and broadcast to everyone in it.
    await vi.advanceTimersByTimeAsync(5000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage({
      type: 'joinRoomSuccess',
      payload: { roomName: 'room-b', displayName: 'room-b', media: [], users: [], previousMatches: [], filters: [] },
    });
    await vi.advanceTimersByTimeAsync(0);

    // Rejects rather than resolving silently: handleApply closes the panel on
    // send, so a silent drop leaves the user staring at an unchanged deck with
    // no explanation. createStore turns the rejection into a toast.
    expect(await settled).toMatch(/room-a/);
    expect(MockWebSocket.latest().sent.some((f) => f.includes('applyFilters'))).toBe(false);
  });

  // Room affinity alone is not enough: currentRoomName survives a reconnect,
  // so a parked apply for the SAME room waves straight through onto a socket
  // that has neither logged in nor rejoined. The wait resumes on "connected",
  // which fires before either, and the server drops the frame at its
  // membership gate without replying.
  it('does not send an apply on a socket that has not rejoined, even for the same room', async () => {
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

    const settled = client.applyFilters({ filters: [] }).then(
      () => 'resolved',
      (err: Error & { userFacing?: unknown }) => `${err.userFacing}: ${err.message}`,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    // Tagged user-facing, because re-tapping Apply genuinely works.
    expect(await settled).toMatch(/^true: The connection dropped/);
    expect(ws2.sent.some((f) => f.includes('applyFilters'))).toBe(false);
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

    // Swipe while down, so the rate queues and records its id.
    ws.simulateClose();
    await client.rate({ mediaId: 'm1', rating: 'like' });

    // joinOrCreateRoom clears sentRateIds, and the server built its deck
    // before this rate landed, so the card comes back.
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

    // Without re-recording the id during the flush, the re-swipe reaches the
    // server, hits the already-rated branch, and counts as neither a vote nor
    // progress: the progress bar then disagrees with the card count.
    await client.rate({ mediaId: 'm1', rating: 'like' });
    expect(rateFrames().length).toBe(afterFlush);
  });
});

// sentRateIds records at SEND time and the protocol has no rate ack, so any
// frame the server drops leaves an id behind that silently eats every later
// swipe of that card. The server's own per-user `media` is the only truth
// available, and it arrives on exactly these three frames.
describe('sentRateIds reconciles against server truth', () => {
  const ratesSent = (ws: MockWebSocket) =>
    ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'rate');

  it('forgets an id the server still lists as unrated after a filter change', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    await client.rate({ mediaId: 'm1', rating: 'like' });
    expect(ratesSent(ws)).toHaveLength(1);

    // The server never recorded that rate (it landed before the join finished,
    // or past the WS rate limit), so m1 is still in this user's deck and the
    // filter change puts the card back on screen.
    ws.simulateMessage({
      type: 'filterChangeApplied',
      payload: { appliedBy: 'someone', filters: [], media: [{ id: 'm1' }] },
    });

    await client.rate({ mediaId: 'm1', rating: 'like' });
    expect(ratesSent(ws)).toHaveLength(2);
  });

  it('keeps an id the server has recorded, so a repeat swipe still sends nothing', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    await client.rate({ mediaId: 'm1', rating: 'like' });
    // m1 is absent from the new deck, which is the server saying it took the
    // vote. Reconciling must not widen into a blanket reset of the dedup set.
    ws.simulateMessage({
      type: 'filterChangeApplied',
      payload: { appliedBy: 'someone', filters: [], media: [{ id: 'm2' }] },
    });

    await client.rate({ mediaId: 'm1', rating: 'like' });
    expect(ratesSent(ws)).toHaveLength(1);
  });

  it('tolerates a join payload with no media array', async () => {
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();
    expect(() =>
      ws.simulateMessage({ type: 'joinRoomSuccess', payload: {} }),
    ).not.toThrow();
    await client.rate({ mediaId: 'm1', rating: 'like' });
    expect(ratesSent(ws)).toHaveLength(1);
  });

  // Ordering guard. The flush re-records the ids it replays, and the join
  // payload lists those same cards because the server built its deck before
  // the rates landed. Reconcile must therefore run BEFORE the flush, or the
  // replayed vote is immediately followed by a duplicate.
  it('re-records a flushed id even when the join payload still lists that card', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws = MockWebSocket.latest();

    ws.simulateOpen();
    ws.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a', media: [] } });
    ws.simulateClose();
    await client.rate({ mediaId: 'm1', rating: 'like' });

    await vi.advanceTimersByTimeAsync(2_000);
    const ws2 = MockWebSocket.latest();
    ws2.simulateOpen();
    ws2.simulateMessage({
      type: 'joinRoomSuccess',
      payload: { roomName: 'room-a', media: [{ id: 'm1' }] },
    });

    expect(ratesSent(ws2)).toHaveLength(1);
    await client.rate({ mediaId: 'm1', rating: 'like' });
    expect(ratesSent(ws2)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

// A join blocks on the server's first provider fetch, which budgets 30s per
// HTTP call with a retry, so the reply can outlast the deadline every other
// request uses. Giving up at 15s toasts a failure the user then watches
// succeed, because the joinRoomSuccess still arrives and lands them in the room.
describe('room-entry requests get a longer reply deadline', () => {
  it('keeps waiting for a join reply past the ordinary request timeout', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    const ws = MockWebSocket.latest();
    ws.simulateOpen();

    const settled = client.joinOrCreateRoom({ roomName: 'room-a' }).then(
      (msg) => msg.type,
      (err: Error) => err.message,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Well past REQUEST_TIMEOUT_MS (15s), inside the room deadline.
    await vi.advanceTimersByTimeAsync(40_000);
    ws.simulateMessage({ type: 'joinRoomSuccess', payload: { roomName: 'room-a', media: [] } });

    expect(await settled).toBe('joinRoomSuccess');
  });

  it('still gives up on a join that never gets a reply', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();

    const settled = client.joinOrCreateRoom({ roomName: 'room-a' }).then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    // 75s is ROOM_REQUEST_TIMEOUT_MS in the source.
    await vi.advanceTimersByTimeAsync(75_001);

    expect(await settled).toMatch(/Timed out/);
  });

  it('leaves the ordinary request deadline at 15s', async () => {
    vi.useFakeTimers();
    const ReelyClient = await loadClient();
    const client = new ReelyClient();
    MockWebSocket.latest().simulateOpen();

    const settled = client.login({ userName: 'someone' }).then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    await vi.advanceTimersByTimeAsync(15_001);

    expect(await settled).toMatch(/Timed out/);
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

    // The store reads this flag to decide whether to show a rejection
    // verbatim. Without it the user gets "The server isn't responding",
    // blaming the server for something it never saw.
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
