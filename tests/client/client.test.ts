import { describe, it, expect, vi, beforeEach } from 'vitest';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

vi.mock('../../internal/app/reely/config/main', () => ({
  getConfig: vi.fn().mockReturnValue({ servers: [], basicAuth: undefined }),
}));

vi.mock('../../internal/app/reely/roomStore', () => ({
  loadRoom: vi.fn().mockResolvedValue(undefined),
  saveRoom: vi.fn().mockResolvedValue(undefined),
  scheduleSaveRoom: vi.fn(),
}));

vi.mock('../../internal/app/reely/i18n', () => ({
  loadTranslation: vi.fn().mockResolvedValue({}),
  getTranslations: vi.fn().mockResolvedValue({}),
}));

// Registry functions become vi.fn()s; the real Room and error classes stay so
// the client's instanceof checks still match.
vi.mock('../../internal/app/reely/room', async () => {
  const actual = await vi.importActual<typeof import('../../internal/app/reely/room')>(
    '../../internal/app/reely/room',
  );
  return {
    ...actual,
    hasRoom: vi.fn().mockReturnValue(false),
    createRoom: vi.fn(),
    getRoom: vi.fn(),
    addRoom: vi.fn(),
    // These fake Rooms are never in the real registry, so the real predicate
    // would refuse every commit. Its own tests are below.
    isRegisteredRoom: vi.fn().mockReturnValue(true),
  };
});

import { Client } from '../../internal/app/reely/client';
import {
  RoomExistsError,
  hasRoom,
  createRoom,
  getRoom,
  isRegisteredRoom,
} from '../../internal/app/reely/room';
import type { Room } from '../../internal/app/reely/room';
import { getConfig } from '../../internal/app/reely/config/main';
import type { ReelyProvider } from '../../internal/app/reely/providers/types';
import { makeWs, push, sent, flush } from '../helpers';

const mockedHasRoom = vi.mocked(hasRoom);
const mockedCreateRoom = vi.mocked(createRoom);
const mockedGetRoom = vi.mocked(getRoom);
const mockedGetConfig = vi.mocked(getConfig);
const mockedIsRegisteredRoom = vi.mocked(isRegisteredRoom);

// ---------------------------------------------------------------------------

describe('Client login handling', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;

  beforeEach(() => {
    ws = makeWs();
    client = new Client(ws, []);
    ws.send.mockClear(); // discard the initial config message
  });

  // sanitizeInput('///') is ''. Guards against logging in with an empty
  // username, which created data/rooms/.json.
  it('sends loginError when the username is empty after sanitization', async () => {
    await push(ws, { type: 'login', payload: { userName: '///' } });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('loginError');
    expect(msgs[0].payload.name).toBe('MalformedMessage');
    expect(client.isLoggedIn).toBe(false);
    expect(client.userName).toBeUndefined();
  });

  it('sends loginError for an all-whitespace username', async () => {
    await push(ws, { type: 'login', payload: { userName: '   ' } });
    const msgs = sent(ws);
    expect(msgs[0].type).toBe('loginError');
    expect(client.isLoggedIn).toBe(false);
  });

  // Guards against loginSuccess echoing the raw userName instead of the
  // sanitized one stored server-side.
  it('sends loginSuccess with the sanitized username, not the raw input', async () => {
    await push(ws, { type: 'login', payload: { userName: '  alice../  ' } });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('loginSuccess');
    // sanitizeInput('  alice../  ') → 'alice'
    expect(msgs[0].payload.userName).toBe('alice');
    expect(client.userName).toBe('alice');
    expect(client.isLoggedIn).toBe(true);
  });

  it('sends loginSuccess for a clean username unchanged', async () => {
    await push(ws, { type: 'login', payload: { userName: 'bob' } });
    const msgs = sent(ws);
    expect(msgs[0].type).toBe('loginSuccess');
    expect(msgs[0].payload.userName).toBe('bob');
  });
});

// ---------------------------------------------------------------------------

describe('Client rate handling', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;
  let storeRating: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ws = makeWs();
    client = new Client(ws, []);
    ws.send.mockClear();

    storeRating = vi.fn().mockResolvedValue(undefined);
    const media = new Map([['media-1', { id: 'media-1', title: 'Film' }]]);

    // handleRate accepts a rating only if this Client is the live entry for
    // its username, so `users` has to carry it.
    client.userName = 'alice';
    client.room = {
      media: Promise.resolve(media),
      storeRating,
      users: new Map([['alice', client]]),
    } as unknown as Room;
  });

  // Guards against a client polluting the ratings map with arbitrary IDs.
  it('drops a rating for an unknown mediaId', async () => {
    await push(ws, { type: 'rate', payload: { rating: 'like', mediaId: 'bogus-id' } });
    await flush();
    expect(storeRating).not.toHaveBeenCalled();
  });

  it('stores a rating for a known mediaId', async () => {
    await push(ws, { type: 'rate', payload: { rating: 'like', mediaId: 'media-1' } });
    await flush();
    expect(storeRating).toHaveBeenCalledWith(
      'alice',
      { rating: 'like', mediaId: 'media-1' },
      expect.any(Number),
    );
  });

  // Guards against a rating landing for a user who left. Two defences: leave
  // detaches this.room, and handleRate asserts membership.
  it('drops a rating after leaveRoom', async () => {
    await push(ws, { type: 'leaveRoom' });
    await flush();
    await push(ws, { type: 'rate', payload: { rating: 'like', mediaId: 'media-1' } });
    await flush();
    expect(storeRating).not.toHaveBeenCalled();
  });

  it('drops a rating from a stale connection', async () => {
    // Soft-refresh race: a newer Client takes the slot before the old socket's
    // handleRate fires.
    const newerClient = {} as unknown as Client;
    // biome-ignore lint/style/noNonNullAssertion: room set by beforeEach.
    (client.room!.users as Map<string, Client>).set('alice', newerClient);
    await push(ws, { type: 'rate', payload: { rating: 'like', mediaId: 'media-1' } });
    await flush();
    expect(storeRating).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('Client applyFilters handling', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;
  let applyFilters: ReturnType<typeof vi.fn>;
  let notifyFilterApplied: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ws = makeWs();
    client = new Client(ws, []);
    ws.send.mockClear();

    applyFilters = vi.fn().mockResolvedValue([]);
    notifyFilterApplied = vi.fn();

    client.userName = 'alice';
    client.isLoggedIn = true;
    client.room = {
      users: new Map([['alice', client]]),
      applyFilters,
      notifyFilterApplied,
    } as unknown as Room;
  });

  // Filter keys are interpolated into a Plex API URL path, so a
  // path-traversal key must never reach it.
  it('rejects a filter payload with an invalid key', async () => {
    await push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: '../evil', operator: '=', value: ['x'] }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
    expect(notifyFilterApplied).not.toHaveBeenCalled();
  });

  it('rejects a filter payload where value is not a string array', async () => {
    await push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre', operator: '=', value: 'not-an-array' }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects a filter payload where filters is not an array', async () => {
    await push(ws, {
      type: 'applyFilters',
      payload: { filters: 'bad' },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('applies and broadcasts a valid filter payload', async () => {
    await push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre', operator: '=', value: ['Action'] }] },
    });
    await flush();
    expect(applyFilters).toHaveBeenCalledWith([
      { key: 'genre', operator: '=', value: ['Action'] },
    ]);
    expect(notifyFilterApplied).toHaveBeenCalledWith(
      'alice',
      [],
      [{ key: 'genre', operator: '=', value: ['Action'] }],
    );
  });

  it('rejects a key longer than 64 chars', async () => {
    await push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'a'.repeat(65), operator: '=', value: ['x'] }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects an empty value array', async () => {
    await push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre', operator: '=', value: [] }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects a value array with more than 32 entries', async () => {
    await push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre', operator: '=', value: Array(33).fill('x') }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects a value string over 128 chars', async () => {
    await push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre', operator: '=', value: ['x'.repeat(129)] }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects an operator outside the regex charset', async () => {
    await push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre', operator: 'abc', value: ['x'] }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects an applyFilters message with null payload', async () => {
    await push(ws, { type: 'applyFilters', payload: null });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects an applyFilters message where filters is not an array', async () => {
    await push(ws, { type: 'applyFilters', payload: { filters: 'oops' } });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('Client requestFilters handling', () => {
  let ws: ReturnType<typeof makeWs>;

  beforeEach(() => {
    ws = makeWs();
  });

  // Guards against a getFilters() throw sending nothing back, which leaves
  // the FilterPanel stuck loading forever.
  it('sends requestFiltersError when getFilters() rejects (B1+B2)', async () => {
    const provider = {
      getFilters: vi.fn().mockRejectedValue(new Error('plex unreachable')),
    } as unknown as ConstructorParameters<typeof Client>[1][number];
    const c = new Client(ws, [provider]);
    c.userName = 'alice';
    c.isLoggedIn = true;
    ws.send.mockClear(); // discard the initial config message
    await push(ws, { type: 'requestFilters' });
    await flush();
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('requestFiltersError');
  });

  it('sends requestFiltersSuccess when getFilters() resolves', async () => {
    const filters = { filters: [], filterTypes: {} };
    const provider = {
      getFilters: vi.fn().mockResolvedValue(filters),
    } as unknown as ConstructorParameters<typeof Client>[1][number];
    const c = new Client(ws, [provider]);
    c.userName = 'alice';
    c.isLoggedIn = true;
    ws.send.mockClear();
    await push(ws, { type: 'requestFilters' });
    await flush();
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('requestFiltersSuccess');
    expect(msgs[0].payload).toEqual(filters);
  });

  it('sends requestFiltersError when no providers are configured', async () => {
    new Client(ws, []);
    ws.send.mockClear();
    await push(ws, { type: 'requestFilters' });
    await flush();
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('requestFiltersError');
  });
});

// ---------------------------------------------------------------------------

describe('Client malformed-payload handling', () => {
  let ws: ReturnType<typeof makeWs>;

  beforeEach(() => {
    ws = makeWs();
  });

  // Guards against a malformed payload throwing, being swallowed by the
  // handleRawMessage catch, and hanging the client awaiting a reply.
  it('answers a login with no userName with loginError, not silence', async () => {
    new Client(ws, []);
    ws.send.mockClear();
    await push(ws, { type: 'login', payload: {} });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('loginError');
    expect(msgs[0].payload.name).toBe('MalformedMessage');
  });

  it('answers a createRoom with no roomName with createRoomError', async () => {
    const client = new Client(ws, []);
    client.userName = 'alice';
    client.isLoggedIn = true;
    ws.send.mockClear();
    await push(ws, { type: 'createRoom', payload: {} });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('createRoomError');
  });

  it('answers a joinRoom with no roomName with joinRoomError', async () => {
    const client = new Client(ws, []);
    client.userName = 'alice';
    client.isLoggedIn = true;
    ws.send.mockClear();
    await push(ws, { type: 'joinRoom', payload: {} });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('joinRoomError');
  });

  it('answers a requestFilterValues with a null payload with requestFilterValuesError', async () => {
    const c = new Client(ws, []);
    c.userName = 'alice';
    c.isLoggedIn = true;
    ws.send.mockClear();
    await push(ws, { type: 'requestFilterValues', payload: null });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('requestFilterValuesError');
  });
});

// ---------------------------------------------------------------------------

// The Room surface handleJoinOrCreateRoom touches.
const makeFakeRoom = (roomName: string) => ({
  roomName,
  users: new Map<string, Client>(),
  userProgress: new Map<string, number>(),
  media: Promise.resolve(new Map()),
  filters: undefined as undefined | unknown[],
  getMatches: vi.fn().mockResolvedValue([]),
  getMediaForUser: vi.fn().mockResolvedValue([]),
  getUsers: vi.fn().mockResolvedValue([]),
  notifyJoin: vi.fn(),
} as unknown as Room);

describe('Client joinOrCreateRoom routing', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;

  beforeEach(() => {
    mockedHasRoom.mockReset();
    mockedCreateRoom.mockReset();
    mockedGetRoom.mockReset();
    ws = makeWs();
    client = new Client(ws, []);
    ws.send.mockClear();
    client.userName = 'alice';
    client.isLoggedIn = true;
  });

  it('takes the join path when the room already exists in memory', async () => {
    mockedHasRoom.mockReturnValue(true);
    mockedGetRoom.mockReturnValue(makeFakeRoom('movie-night'));

    await push(ws, { type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(mockedGetRoom).toHaveBeenCalled();
    expect(mockedCreateRoom).not.toHaveBeenCalled();
    expect(sent(ws).some((m) => m.type === 'joinRoomSuccess')).toBe(true);
  });

  it('takes the create path when the room does not exist', async () => {
    mockedHasRoom.mockReturnValue(false);
    mockedCreateRoom.mockResolvedValue(makeFakeRoom('movie-night'));

    await push(ws, { type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(mockedCreateRoom).toHaveBeenCalled();
    expect(mockedGetRoom).not.toHaveBeenCalled();
    expect(sent(ws).some((m) => m.type === 'createRoomSuccess')).toBe(true);
  });

  // Another client can win the race between the probe and the create.
  it('retries as join when create loses a RoomExistsError race', async () => {
    mockedHasRoom.mockReturnValue(false);
    mockedCreateRoom.mockRejectedValueOnce(new RoomExistsError('movie-night already exists.'));
    mockedGetRoom.mockReturnValue(makeFakeRoom('movie-night'));

    await push(ws, { type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(mockedCreateRoom).toHaveBeenCalledTimes(1);
    expect(mockedGetRoom).toHaveBeenCalledTimes(1);
    const msgs = sent(ws);
    expect(msgs.some((m) => m.type === 'joinRoomSuccess')).toBe(true);
    expect(msgs.some((m) => m.type === 'createRoomError')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

// Two regressions. A rejected joiner that keeps this.room lets a later rename
// wipe the active user's progress. And a holder must be probed for liveness,
// or a user's own zombie connection (still OPEN until the ping sweep) blocks
// their rejoin: only a demonstrably live holder rejects.
describe('Client join username collision', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;

  // `pong: true` answers the ping (live); `pong: false` never does (zombie).
  const makeHolderWs = (opts: { pong?: boolean; readyState?: number } = {}) => {
    const holderWs = makeWs();
    return Object.assign(holderWs, {
      readyState: opts.readyState ?? 1, // WebSocket.OPEN
      ping: vi.fn(() => {
        if (opts.pong) holderWs.emit('pong');
      }),
      terminate: vi.fn(),
    });
  };

  const makeCollisionRoom = (holder: Client) => {
    const room = makeFakeRoom('movie-night');
    (room.users as Map<string, Client>).set('alice', holder);
    (room.userProgress as Map<string, number>).set('alice', 5);
    mockedHasRoom.mockReturnValue(true);
    mockedGetRoom.mockReturnValue(room);
    return room;
  };

  beforeEach(() => {
    mockedHasRoom.mockReset();
    mockedGetRoom.mockReset();
    ws = makeWs();
    client = new Client(ws, []);
    ws.send.mockClear();
    client.userName = 'alice';
    client.isLoggedIn = true;
  });

  it('rejects the join when the name is held by a live connection', async () => {
    const holderWs = makeHolderWs({ pong: true });
    const holder = { ws: holderWs } as unknown as Client;
    const room = makeCollisionRoom(holder);

    await push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
    await flush();

    const msgs = sent(ws);
    expect(msgs.some((m) => m.type === 'joinRoomError' && m.payload.name === 'UsernameTakenError')).toBe(true);
    expect(room.users.get('alice')).toBe(holder);
    expect(holderWs.terminate).not.toHaveBeenCalled();
    // The rejected joiner holds no reference to the room.
    expect(client.room).toBeUndefined();
  });

  it('a rejected joiner cannot wipe the active user\'s progress via a rename', async () => {
    const holderWs = makeHolderWs({ pong: true });
    const holder = { ws: holderWs } as unknown as Client;
    const room = makeCollisionRoom(holder);

    await push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
    await flush();
    ws.send.mockClear();

    // The rejected user follows the "pick a different name" prompt. Guards
    // against handleLogin's cleanup getting the never-joined room back from
    // leaveRoomCleanup and deleting the active alice's userProgress.
    await push(ws, { type: 'login', payload: { userName: 'bob' } });
    await flush();

    expect(sent(ws).some((m) => m.type === 'loginSuccess')).toBe(true);
    expect(room.userProgress.get('alice')).toBe(5);
    expect(room.users.get('alice')).toBe(holder);
  });

  it('displaces a holder whose socket is already closed', async () => {
    const holderWs = makeHolderWs({ readyState: 3 }); // WebSocket.CLOSED
    const holder = { ws: holderWs } as unknown as Client;
    const room = makeCollisionRoom(holder);

    await push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(sent(ws).some((m) => m.type === 'joinRoomSuccess')).toBe(true);
    expect(room.users.get('alice')).toBe(client);
    expect(client.room).toBe(room);
    expect(holderWs.terminate).toHaveBeenCalled();
  });

  it('displaces a holder that never answers the liveness probe', async () => {
    vi.useFakeTimers();
    try {
      const holderWs = makeHolderWs({ pong: false }); // OPEN but half-open zombie
      const holder = { ws: holderWs } as unknown as Client;
      const room = makeCollisionRoom(holder);

      await push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
      // Past the 2s probe deadline, draining the async join.
      await vi.advanceTimersByTimeAsync(2100);

      expect(holderWs.ping).toHaveBeenCalled();
      expect(holderWs.terminate).toHaveBeenCalled();
      expect(room.users.get('alice')).toBe(client);
      expect(sent(ws).some((m) => m.type === 'joinRoomSuccess')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------

// The WS `config` frame must respect the EXPOSE_PLEX_BASE_URL opt-out.
describe('Client sendConfig plexBaseUrl exposure', () => {
  const makeFakePlexProvider = (url = 'http://192.168.1.20:32400'): ReelyProvider => ({
    type: 'plex',
    options: { url },
    isAvailable: vi.fn().mockResolvedValue(true),
    isUserAuthorized: vi.fn().mockResolvedValue(true),
    getName: vi.fn().mockResolvedValue('Home'),
    getServerId: vi.fn().mockResolvedValue('server-machine-id'),
  } as unknown as ReelyProvider);

  const firstConfigPayload = async (ws: ReturnType<typeof makeWs>) => {
    await flush();
    const msgs = sent(ws);
    const config = msgs.find((m) => m.type === 'config');
    expect(config, 'no config message sent').toBeTruthy();
    // biome-ignore lint/style/noNonNullAssertion: asserted truthy above.
    return config!.payload;
  };

  it('includes plexBaseUrl by default (exposePlexBaseUrl=true)', async () => {
    mockedGetConfig.mockReturnValue({
      servers: [{ url: 'http://192.168.1.20:32400', token: 'tok' }],
      basicAuth: undefined,
      exposePlexBaseUrl: true,
    } as ReturnType<typeof getConfig>);

    const ws = makeWs();
    new Client(ws, [makeFakePlexProvider()]);
    const payload = await firstConfigPayload(ws);

    expect(payload.plexBaseUrl).toBe('http://192.168.1.20:32400');
  });

  it('omits plexBaseUrl when exposePlexBaseUrl=false', async () => {
    mockedGetConfig.mockReturnValue({
      servers: [{ url: 'http://192.168.1.20:32400', token: 'tok' }],
      basicAuth: undefined,
      exposePlexBaseUrl: false,
    } as ReturnType<typeof getConfig>);

    const ws = makeWs();
    new Client(ws, [makeFakePlexProvider()]);
    const payload = await firstConfigPayload(ws);

    expect(payload.plexBaseUrl).toBeUndefined();
    // Other fields still ship; the gate covers plexBaseUrl only.
    expect(payload.providerType).toBe('plex');
    expect(payload.plexServerId).toBe('server-machine-id');
  });

  it('includes plexBaseUrl when exposePlexBaseUrl is undefined (no default applied)', async () => {
    // The gate is `!== false`, so a Client built before applyDefaults runs
    // still exposes the URL.
    mockedGetConfig.mockReturnValue({
      servers: [{ url: 'http://192.168.1.20:32400', token: 'tok' }],
      basicAuth: undefined,
    } as ReturnType<typeof getConfig>);

    const ws = makeWs();
    new Client(ws, [makeFakePlexProvider()]);
    const payload = await firstConfigPayload(ws);

    expect(payload.plexBaseUrl).toBe('http://192.168.1.20:32400');
  });
});

// applyFilters is fire-and-forget, so a validation failure that returns
// silently leaves the panel looking applied while the room never changed.
describe('Client applyFilters validation errors answer', () => {
  let ws: ReturnType<typeof makeWs>;

  beforeEach(() => {
    ws = makeWs();
    const client = new Client(ws, []);
    client.userName = 'alice';
    client.isLoggedIn = true;
    client.room = {
      users: new Map([['alice', client]]),
      applyFilters: vi.fn().mockResolvedValue([]),
      notifyFilterApplied: vi.fn(),
    } as unknown as Room;
    ws.send.mockClear();
  });

  it('answers an invalid-shape payload with filterChangeError', async () => {
    await push(ws, { type: 'applyFilters', payload: null });
    await flush();
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('filterChangeError');
  });

  it('answers an invalid filter entry with filterChangeError', async () => {
    await push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: '../evil', operator: '=', value: ['x'] }] },
    });
    await flush();
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('filterChangeError');
  });
});

// ---------------------------------------------------------------------------

// Room-mutating handlers capture state before a multi-second await and commit
// after. One TCP read can carry several frames, so unserialised handlers let
// an interleaved frame change the world underneath a parked one.
describe('Client dispatch serialisation', () => {
  let ws: ReturnType<typeof makeWs>;

  beforeEach(() => {
    vi.clearAllMocks();
    ws = makeWs();
    mockedGetConfig.mockReturnValue({
      servers: [],
      basicAuth: undefined,
    } as unknown as ReturnType<typeof getConfig>);
  });

  it('does not start a handler while an earlier one is still awaiting', async () => {
    const client = new Client(ws, []);
    client.userName = 'alice';
    client.isLoggedIn = true;

    const order: string[] = [];
    let releaseCreate: (() => void) | undefined;
    mockedHasRoom.mockReturnValue(false);
    mockedCreateRoom.mockImplementation((async () => {
      order.push('create:start');
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      order.push('create:end');
      throw new RoomExistsError('stop here');
    }) as unknown as typeof createRoom);

    // One read, two frames: a create that parks, then a login.
    ws.emit('message', JSON.stringify({ type: 'createRoom', payload: { roomName: 'movies' } }));
    ws.emit('message', JSON.stringify({ type: 'login', payload: { userName: 'bob' } }));
    for (let i = 0; i < 25; i += 1) await Promise.resolve();

    // The login is queued behind the parked create, so userName is untouched.
    // Running it during the await made the create commit its entry under a
    // username no cleanup path could match: an unremovable member.
    expect(order).toEqual(['create:start']);
    expect(client.getUsername()).toBe('alice');

    releaseCreate?.();
    for (let i = 0; i < 25; i += 1) await Promise.resolve();

    expect(order).toEqual(['create:start', 'create:end']);
    expect(client.getUsername()).toBe('bob');
  });

  it('does not make read-only handlers wait behind a parked room handler', async () => {
    const client = new Client(ws, []);
    client.userName = 'alice';
    client.isLoggedIn = true;

    const order: string[] = [];
    let releaseCreate: (() => void) | undefined;
    mockedHasRoom.mockReturnValue(false);
    mockedCreateRoom.mockImplementation((async () => {
      order.push('create:start');
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      throw new RoomExistsError('stop here');
    }) as unknown as typeof createRoom);

    ws.emit('message', JSON.stringify({ type: 'createRoom', payload: { roomName: 'movies' } }));
    ws.emit('message', JSON.stringify({ type: 'setLocale', payload: { language: 'en' } }));
    for (let i = 0; i < 25; i += 1) await Promise.resolve();

    // setLocale touches no connection state, so it must not wait on the
    // create's Plex fetch. Serialising everything pushed the filter panel's
    // parallel value fetches past the client's 15s timeout and dropped swipes
    // behind a slow applyFilters.
    expect(order).toEqual(['create:start']);
    expect(sent(ws).some((m) => m.type === 'translations')).toBe(true);

    releaseCreate?.();
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  });

  it('runs close after an in-flight handler rather than racing it', async () => {
    const client = new Client(ws, []);
    client.userName = 'alice';
    client.isLoggedIn = true;
    // Pre-existing membership gives handleClose real work, so its ordering is
    // observable; without it the test passes either way.
    const oldRoom = {
      roomName: 'old',
      users: new Map<string, Client>([['alice', client]]),
      notifyLeave: vi.fn(),
      getUsers: vi.fn().mockResolvedValue([]),
    } as unknown as Room;
    client.room = oldRoom;

    const order: string[] = [];
    let releaseCreate: (() => void) | undefined;
    mockedHasRoom.mockReturnValue(false);
    mockedCreateRoom.mockImplementation((async () => {
      order.push('create:start');
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      order.push('create:end');
      throw new RoomExistsError('stop here');
    }) as unknown as typeof createRoom);

    await push(ws, { type: 'createRoom', payload: { roomName: 'movies' } });
    // Socket drops mid-create. If handleClose runs while this.room is still
    // undefined it cleans up nothing, and the create then commits a member no
    // later event can remove.
    (ws as unknown as { readyState: number }).readyState = 3;
    ws.emit('close');
    for (let i = 0; i < 25; i += 1) await Promise.resolve();

    // Close is queued behind the parked create: cleanup has not run yet.
    expect(order).toEqual(['create:start']);
    expect(oldRoom.users.get('alice')).toBe(client);
    expect(vi.mocked(oldRoom.notifyLeave)).not.toHaveBeenCalled();

    releaseCreate?.();
    for (let i = 0; i < 25; i += 1) await Promise.resolve();

    // Once the create settles, close runs and evicts.
    expect(order).toEqual(['create:start', 'create:end']);
    expect(oldRoom.users.has('alice')).toBe(false);
    expect(vi.mocked(oldRoom.notifyLeave)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

// Without a login gate, anyone who completes the WS upgrade can read the
// library's filter schema and drive Plex calls anonymously.
describe('Client filter handlers require login', () => {
  let ws: ReturnType<typeof makeWs>;

  beforeEach(() => {
    vi.clearAllMocks();
    ws = makeWs();
    mockedGetConfig.mockReturnValue({
      servers: [],
      basicAuth: undefined,
    } as unknown as ReturnType<typeof getConfig>);
  });

  it('refuses requestFilters from a client that never logged in', async () => {
    const getFilters = vi.fn().mockResolvedValue({ filters: [], filterTypes: {} });
    const provider = { getFilters } as unknown as ConstructorParameters<typeof Client>[1][number];
    new Client(ws, [provider]);
    ws.send.mockClear();

    await push(ws, { type: 'requestFilters' });

    expect(sent(ws)[0].type).toBe('requestFiltersError');
    // Plex is never consulted for an anonymous peer.
    expect(getFilters).not.toHaveBeenCalled();
  });

  it('refuses requestFilterValues from a client that never logged in', async () => {
    const getFilterValues = vi.fn().mockResolvedValue([]);
    const provider = {
      getFilterValues,
    } as unknown as ConstructorParameters<typeof Client>[1][number];
    new Client(ws, [provider]);
    ws.send.mockClear();

    await push(ws, { type: 'requestFilterValues', payload: { key: 'genre' } });

    expect(sent(ws)[0].type).toBe('requestFilterValuesError');
    expect(getFilterValues).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

// Filters on createRoom/joinRoom must hit the same caps as the applyFilters
// path. The create path persists what it is given, so a bad filter set
// replays from disk on every restart.
describe('Client validates filters on the create path', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;

  beforeEach(() => {
    vi.clearAllMocks();
    ws = makeWs();
    mockedGetConfig.mockReturnValue({
      servers: [],
      basicAuth: undefined,
    } as unknown as ReturnType<typeof getConfig>);
    client = new Client(ws, []);
    client.userName = 'alice';
    client.isLoggedIn = true;
    mockedHasRoom.mockReturnValue(false);
  });

  it.each([
    {
      name: 'an operator the query builder would corrupt',
      filters: [{ key: 'genre', operator: '<', value: ['Drama'] }],
    },
    {
      name: 'a key that is not a plain identifier',
      filters: [{ key: '../../etc/passwd', operator: '=', value: ['x'] }],
    },
    {
      name: 'an oversized value list',
      filters: [{ key: 'genre', operator: '=', value: Array(500).fill('x') }],
    },
    {
      name: 'a non-array filters field',
      filters: 'not-an-array',
    },
  ])('rejects createRoom carrying $name', async ({ filters }) => {
    ws.send.mockClear();

    await push(ws, { type: 'createRoom', payload: { roomName: 'movies', filters } });

    expect(sent(ws)[0].type).toBe('createRoomError');
    // No room built, so the bad filters reach neither Plex nor the JSON file.
    expect(mockedCreateRoom).not.toHaveBeenCalled();
  });

  it('still accepts a well-formed filter set', async () => {
    mockedCreateRoom.mockRejectedValue(new RoomExistsError('stop before I/O'));
    ws.send.mockClear();

    await push(ws, {
      type: 'createRoom',
      payload: { roomName: 'movies', filters: [{ key: 'genre', operator: '=', value: ['Drama'] }] },
    });

    expect(mockedCreateRoom).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

// Both room paths commit membership after multi-second awaits (Plex fetch,
// disk load, liveness probe). An unconditional commit creates an unremovable
// member, pinning the room past the TTL sweep and leaking it until restart.
describe('Client membership commit guard', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;

  const fakeRoom = (roomName: string) =>
    ({
      roomName,
      displayName: roomName,
      users: new Map<string, Client>(),
      filters: [],
      getMatches: vi.fn().mockResolvedValue([]),
      getMediaForUser: vi.fn().mockResolvedValue([]),
      getUsers: vi.fn().mockResolvedValue([]),
    }) as unknown as Room;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsRegisteredRoom.mockReturnValue(true);
    ws = makeWs();
    mockedGetConfig.mockReturnValue({
      servers: [],
      basicAuth: undefined,
    } as unknown as ReturnType<typeof getConfig>);
    client = new Client(ws, []);
    client.userName = 'alice';
    client.isLoggedIn = true;
    ws.send.mockClear();
  });

  it('does not add a member whose socket closed during the create', async () => {
    const room = fakeRoom('movies');
    mockedHasRoom.mockReturnValue(false);
    mockedCreateRoom.mockImplementation((async () => {
      // Tab closes mid-fetch. handleClose already ran and saw no room, so
      // this commit is the last chance to notice.
      (ws as unknown as { readyState: number }).readyState = 3;
      return room;
    }) as unknown as typeof createRoom);

    await push(ws, { type: 'createRoom', payload: { roomName: 'movies' } });

    expect(room.users.size).toBe(0);
    expect(client.room).toBeUndefined();
  });

  it('does not attach a joiner to a room the sweep removed during the probe', async () => {
    const room = fakeRoom('movienight');
    mockedHasRoom.mockReturnValue(true);
    mockedGetRoom.mockReturnValue(room);
    // The TTL sweep collected the room while the join was parked: still
    // reachable through the local, no longer registered under that name.
    mockedIsRegisteredRoom.mockReturnValue(false);

    await push(ws, { type: 'joinRoom', payload: { roomName: 'movienight' } });

    expect(room.users.size).toBe(0);
    expect(client.room).toBeUndefined();
    expect(sent(ws).some((m) => m.type === 'joinRoomSuccess')).toBe(false);
  });

  it('commits normally when the socket is open and the room is still registered', async () => {
    const room = fakeRoom('movienight');
    mockedHasRoom.mockReturnValue(true);
    mockedGetRoom.mockReturnValue(room);

    await push(ws, { type: 'joinRoom', payload: { roomName: 'movienight' } });

    expect(room.users.get('alice')).toBe(client);
    expect(sent(ws).some((m) => m.type === 'joinRoomSuccess')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

// A rename must clear all of the old name's state, and must do nothing when
// leaveRoomCleanup's identity guard declined to evict.
describe('Client login rename cleanup', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;
  let room: Room;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsRegisteredRoom.mockReturnValue(true);
    ws = makeWs();
    mockedGetConfig.mockReturnValue({
      servers: [],
      basicAuth: undefined,
    } as unknown as ReturnType<typeof getConfig>);
    client = new Client(ws, []);
    client.userName = 'alice';
    client.isLoggedIn = true;
    room = {
      roomName: 'movies',
      users: new Map<string, Client>([['alice', client]]),
      userProgress: new Map<string, number>([['alice', 50]]),
      userRated: new Map<string, Set<string>>([['alice', new Set(['m1'])]]),
      notifyLeave: vi.fn(),
      getUsers: vi.fn().mockResolvedValue([]),
    } as unknown as Room;
    client.room = room;
    ws.send.mockClear();
  });

  it('leaves progress and rated state consistent after a rename', async () => {
    await push(ws, { type: 'login', payload: { userName: 'alicia' } });

    // Both survive or neither does. Progress alone reports 0 while the deck
    // stays filtered by the rated set, so the bar never reaches 100%; ratings
    // alone dissolves other users' matches.
    const hasProgress = room.userProgress.has('alice');
    const hasRated = room.userRated.has('alice');
    expect(hasProgress).toBe(hasRated);
    expect(client.getUsername()).toBe('alicia');
  });

  it('does not touch the room when a newer connection already owns the name', async () => {
    // Soft-refresh race: a newer Client took the slot before this one renamed.
    const newer = {} as unknown as Client;
    (room.users as Map<string, Client>).set('alice', newer);

    await push(ws, { type: 'login', payload: { userName: 'alicia' } });

    // No state change and no spurious leave on the active connection's behalf.
    expect(room.userProgress.get('alice')).toBe(50);
    expect(room.users.get('alice')).toBe(newer);
    expect(vi.mocked(room.notifyLeave)).not.toHaveBeenCalled();
  });
});
