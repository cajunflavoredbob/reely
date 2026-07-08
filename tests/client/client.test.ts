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

// Partial mock: replace the room registry functions with vi.fn()s but keep
// the real Room class and the error class hierarchy (RoomExistsError etc.)
// so the client's instanceof checks still work against thrown errors.
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
  };
});

import { Client } from '../../internal/app/reely/client';
import {
  RoomExistsError,
  hasRoom,
  createRoom,
  getRoom,
} from '../../internal/app/reely/room';
import type { Room } from '../../internal/app/reely/room';
import { getConfig } from '../../internal/app/reely/config/main';
import type { ReelyProvider } from '../../internal/app/reely/providers/types';
import { makeWs, push, sent, flush } from '../helpers';

// Cast helpers for the mocked exports.
const mockedHasRoom = vi.mocked(hasRoom);
const mockedCreateRoom = vi.mocked(createRoom);
const mockedGetRoom = vi.mocked(getRoom);
const mockedGetConfig = vi.mocked(getConfig);

// ---------------------------------------------------------------------------

describe('Client login handling', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;

  beforeEach(() => {
    ws = makeWs();
    client = new Client(ws, []);
    ws.send.mockClear(); // discard the initial config message
  });

  // Finding 13: sanitizeInput('///') → ''; the server must reject the empty result
  // instead of logging in with an empty username and creating data/rooms/.json.
  it('sends loginError when the username is empty after sanitization (Finding 13)', () => {
    push(ws, { type: 'login', payload: { userName: '///' } });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('loginError');
    expect(msgs[0].payload.name).toBe('MalformedMessage');
    expect(client.isLoggedIn).toBe(false);
    expect(client.userName).toBeUndefined();
  });

  it('sends loginError for an all-whitespace username', () => {
    push(ws, { type: 'login', payload: { userName: '   ' } });
    const msgs = sent(ws);
    expect(msgs[0].type).toBe('loginError');
    expect(client.isLoggedIn).toBe(false);
  });

  // Finding 24: loginSuccess was sending the raw (unsanitized) login.userName
  // back to the client instead of the sanitized version stored server-side.
  it('sends loginSuccess with the sanitized username, not the raw input (Finding 24)', () => {
    push(ws, { type: 'login', payload: { userName: '  alice../  ' } });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('loginSuccess');
    // sanitizeInput('  alice../  ') → 'alice'
    expect(msgs[0].payload.userName).toBe('alice');
    expect(client.userName).toBe('alice');
    expect(client.isLoggedIn).toBe(true);
  });

  it('sends loginSuccess for a clean username unchanged', () => {
    push(ws, { type: 'login', payload: { userName: 'bob' } });
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

    // Set up a logged-in user in a room. `users` mirrors the active-connection
    // bookkeeping handleRate now asserts against (0.4.1, audit 8 #85): the
    // Client must be the live entry for its username in room.users before any
    // rating is accepted.
    client.userName = 'alice';
    client.room = {
      media: Promise.resolve(media),
      storeRating,
      users: new Map([['alice', client]]),
    } as unknown as Room;
  });

  // Finding 12: handleRate did not validate that the mediaId exists in the room
  // before storing. A client could rate arbitrary IDs, polluting the ratings map.
  it('drops a rating for an unknown mediaId (Finding 12)', async () => {
    push(ws, { type: 'rate', payload: { rating: 'like', mediaId: 'bogus-id' } });
    await flush();
    expect(storeRating).not.toHaveBeenCalled();
  });

  it('stores a rating for a known mediaId', async () => {
    push(ws, { type: 'rate', payload: { rating: 'like', mediaId: 'media-1' } });
    await flush();
    expect(storeRating).toHaveBeenCalledWith(
      'alice',
      { rating: 'like', mediaId: 'media-1' },
      expect.any(Number),
    );
  });

  // Audit 8 #85: prior to 0.4.1, handleLeaveRoom (and handleLogout) removed
  // the user from room.users but never nulled this.room, so the connection
  // could keep emitting `rate` messages that mutated the old room's ratings
  // map without the user actually being a member. Two-part fix in 0.4.1:
  // (1) this.room = undefined on leave/logout; (2) handleRate asserts
  // active-connection membership before mutating. Either alone would close
  // the path; both together is belt-and-suspenders.
  it('drops a rating after leaveRoom (audit 8 #85)', async () => {
    push(ws, { type: 'leaveRoom' });
    await flush();
    push(ws, { type: 'rate', payload: { rating: 'like', mediaId: 'media-1' } });
    await flush();
    expect(storeRating).not.toHaveBeenCalled();
  });

  it('drops a rating from a stale connection (audit 8 #85)', async () => {
    // Simulate a soft-refresh race: a newer Client takes over the user slot
    // before the old socket's handleRate fires. The membership assertion in
    // handleRate is the second half of the #85 fix and must drop the rating.
    const newerClient = {} as unknown as Client;
    // client.room is set in the beforeEach; the test wouldn't reach
    // here without it. Non-null + Map-narrow are the right shape.
    // biome-ignore lint/style/noNonNullAssertion: room set by beforeEach.
    (client.room!.users as Map<string, Client>).set('alice', newerClient);
    push(ws, { type: 'rate', payload: { rating: 'like', mediaId: 'media-1' } });
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

  // Finding 14: handleApplyFilters trusts the payload shape at runtime. An
  // attacker could send a filter with a path-traversal key that gets
  // interpolated into a Plex API URL path -- the validator must reject it.
  it('rejects a filter payload with an invalid key (Finding 14)', async () => {
    push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: '../evil', operator: '=', value: ['x'] }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
    expect(notifyFilterApplied).not.toHaveBeenCalled();
  });

  it('rejects a filter payload where value is not a string array', async () => {
    push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre', operator: '=', value: 'not-an-array' }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects a filter payload where filters is not an array', async () => {
    push(ws, {
      type: 'applyFilters',
      payload: { filters: 'bad' },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('applies and broadcasts a valid filter payload', async () => {
    push(ws, {
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

  // Bounds added in 0.2.9.
  it('rejects a key longer than 64 chars', async () => {
    push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'a'.repeat(65), operator: '=', value: ['x'] }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects an empty value array', async () => {
    push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre', operator: '=', value: [] }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects a value array with more than 32 entries', async () => {
    push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre', operator: '=', value: Array(33).fill('x') }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects a value string over 128 chars', async () => {
    push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre', operator: '=', value: ['x'.repeat(129)] }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects an operator outside the regex charset', async () => {
    push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre', operator: 'abc', value: ['x'] }] },
    });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  // Payload-shape validation added in 0.2.9.
  it('rejects an applyFilters message with null payload', async () => {
    push(ws, { type: 'applyFilters', payload: null });
    await flush();
    expect(applyFilters).not.toHaveBeenCalled();
  });

  it('rejects an applyFilters message where filters is not an array', async () => {
    push(ws, { type: 'applyFilters', payload: { filters: 'oops' } });
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

  // B1+B2: a getFilters() throw used to send nothing back, leaving the
  // frontend's waitForAnyMessage unresolved and the FilterPanel stuck on
  // "Loading filters..." forever. The handler must emit requestFiltersError.
  it('sends requestFiltersError when getFilters() rejects (B1+B2)', async () => {
    const provider = {
      getFilters: vi.fn().mockRejectedValue(new Error('plex unreachable')),
    } as unknown as ConstructorParameters<typeof Client>[1][number];
    new Client(ws, [provider]);
    ws.send.mockClear(); // discard the initial config message
    push(ws, { type: 'requestFilters' });
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
    new Client(ws, [provider]);
    ws.send.mockClear();
    push(ws, { type: 'requestFilters' });
    await flush();
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('requestFiltersSuccess');
    expect(msgs[0].payload).toEqual(filters);
  });

  it('sends requestFiltersError when no providers are configured', async () => {
    new Client(ws, []);
    ws.send.mockClear();
    push(ws, { type: 'requestFilters' });
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

  // Finding 4: message.payload is untrusted JSON. A malformed message used to
  // throw inside the handler, get swallowed by the handleRawMessage catch, and
  // hang the client awaiting a response. Each handler must answer with its
  // own error message instead.
  it('answers a login with no userName with loginError, not silence', () => {
    new Client(ws, []);
    ws.send.mockClear();
    push(ws, { type: 'login', payload: {} });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('loginError');
    expect(msgs[0].payload.name).toBe('MalformedMessage');
  });

  it('answers a createRoom with no roomName with createRoomError', () => {
    const client = new Client(ws, []);
    client.userName = 'alice';
    client.isLoggedIn = true;
    ws.send.mockClear();
    push(ws, { type: 'createRoom', payload: {} });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('createRoomError');
  });

  it('answers a joinRoom with no roomName with joinRoomError', () => {
    const client = new Client(ws, []);
    client.userName = 'alice';
    client.isLoggedIn = true;
    ws.send.mockClear();
    push(ws, { type: 'joinRoom', payload: {} });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('joinRoomError');
  });

  it('answers a requestFilterValues with a null payload with requestFilterValuesError', () => {
    new Client(ws, []);
    ws.send.mockClear();
    push(ws, { type: 'requestFilterValues', payload: null });
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('requestFilterValuesError');
  });
});

// ---------------------------------------------------------------------------

// Builds a minimal Room-shaped object that handleJoinOrCreateRoom can use.
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

    push(ws, { type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(mockedGetRoom).toHaveBeenCalled();
    expect(mockedCreateRoom).not.toHaveBeenCalled();
    expect(sent(ws).some((m) => m.type === 'joinRoomSuccess')).toBe(true);
  });

  it('takes the create path when the room does not exist', async () => {
    mockedHasRoom.mockReturnValue(false);
    mockedCreateRoom.mockResolvedValue(makeFakeRoom('movie-night'));

    push(ws, { type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(mockedCreateRoom).toHaveBeenCalled();
    expect(mockedGetRoom).not.toHaveBeenCalled();
    expect(sent(ws).some((m) => m.type === 'createRoomSuccess')).toBe(true);
  });

  // If another client wins the create race between our probe and our create
  // attempt (rare, but possible), handleJoinOrCreateRoom should catch the
  // RoomExistsError and retry as a join.
  it('retries as join when create loses a RoomExistsError race', async () => {
    mockedHasRoom.mockReturnValue(false);
    mockedCreateRoom.mockRejectedValueOnce(new RoomExistsError('movie-night already exists.'));
    mockedGetRoom.mockReturnValue(makeFakeRoom('movie-night'));

    push(ws, { type: 'joinOrCreateRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(mockedCreateRoom).toHaveBeenCalledTimes(1);
    expect(mockedGetRoom).toHaveBeenCalledTimes(1);
    const msgs = sent(ws);
    expect(msgs.some((m) => m.type === 'joinRoomSuccess')).toBe(true);
    expect(msgs.some((m) => m.type === 'createRoomError')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

// Audit 16 #419 + #421: username-collision handling on join. #419 -- a
// rejected joiner must not keep a this.room reference (it let a follow-up
// login-rename wipe the ACTIVE user's userProgress through
// leaveRoomCleanup's returned room). #421 -- the 0.5.22 UsernameTakenError
// guard must probe the holder's liveness so a user's own zombie connection
// (unclean drop; socket looks OPEN until the ping sweep) can't block their
// auto-rejoin: only a demonstrably live holder rejects.
describe('Client join username collision (audit 16 #419 + #421)', () => {
  let ws: ReturnType<typeof makeWs>;
  let client: Client;

  // Holder-socket double: EventEmitter (once/off for the pong listener) plus
  // the probe surface. `pong: true` answers the liveness ping synchronously
  // (a live connection); `pong: false` never answers (half-open zombie).
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

    push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
    await flush();

    const msgs = sent(ws);
    expect(msgs.some((m) => m.type === 'joinRoomError' && m.payload.name === 'UsernameTakenError')).toBe(true);
    expect(room.users.get('alice')).toBe(holder);
    expect(holderWs.terminate).not.toHaveBeenCalled();
    // #419: the rejected joiner holds no reference to the room.
    expect(client.room).toBeUndefined();
  });

  it('a rejected joiner cannot wipe the active user\'s progress via a rename (audit 16 #419)', async () => {
    const holderWs = makeHolderWs({ pong: true });
    const holder = { ws: holderWs } as unknown as Client;
    const room = makeCollisionRoom(holder);

    push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
    await flush();
    ws.send.mockClear();

    // The rejected user follows the "pick a different name" prompt: a login
    // rename on the same connection. Pre-fix, handleLogin's cleanup got the
    // never-joined room back from leaveRoomCleanup and deleted the ACTIVE
    // alice's userProgress from it.
    push(ws, { type: 'login', payload: { userName: 'bob' } });
    await flush();

    expect(sent(ws).some((m) => m.type === 'loginSuccess')).toBe(true);
    expect(room.userProgress.get('alice')).toBe(5);
    expect(room.users.get('alice')).toBe(holder);
  });

  it('displaces a holder whose socket is already closed (audit 16 #421)', async () => {
    const holderWs = makeHolderWs({ readyState: 3 }); // WebSocket.CLOSED
    const holder = { ws: holderWs } as unknown as Client;
    const room = makeCollisionRoom(holder);

    push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
    await flush();

    expect(sent(ws).some((m) => m.type === 'joinRoomSuccess')).toBe(true);
    expect(room.users.get('alice')).toBe(client);
    expect(client.room).toBe(room);
    expect(holderWs.terminate).toHaveBeenCalled();
  });

  it('displaces a holder that never answers the liveness probe (audit 16 #421)', async () => {
    vi.useFakeTimers();
    try {
      const holderWs = makeHolderWs({ pong: false }); // OPEN but half-open zombie
      const holder = { ws: holderWs } as unknown as Client;
      const room = makeCollisionRoom(holder);

      push(ws, { type: 'joinRoom', payload: { roomName: 'movie-night' } });
      // Probe deadline is 2s; advance past it and drain the async join.
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

// 0.4.15: EXPOSE_PLEX_BASE_URL opt-out (audit 10 #165 / audit 12 #226).
// Verifies the WS `config` frame respects the flag at the gating point in
// Client.sendConfig().
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
    // expect().toBeTruthy() above guarantees the non-null; TypeScript
    // doesn't track expect-style assertions.
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
    // Other fields still ship -- the gate is scoped to plexBaseUrl only.
    expect(payload.providerType).toBe('plex');
    expect(payload.plexServerId).toBe('server-machine-id');
  });

  it('includes plexBaseUrl when exposePlexBaseUrl is undefined (no default applied)', async () => {
    // applyDefaults normally fills `true`, but the gate is `!== false`, so
    // a missing field still exposes. Belt-and-suspenders against any code
    // path that constructs a Client before defaults run.
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

// Audit 16 #449: applyFilters validation failures previously logged a
// warning and returned SILENTLY -- the client's applyFilters is
// fire-and-forget, so the panel looked applied while the room never
// changed. Both validation paths now answer with filterChangeError like
// the cooldown + fetch-error paths always did.
describe('Client applyFilters validation errors answer (audit 16 #449)', () => {
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
    push(ws, { type: 'applyFilters', payload: null });
    await flush();
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('filterChangeError');
  });

  it('answers an invalid filter entry with filterChangeError', async () => {
    push(ws, {
      type: 'applyFilters',
      payload: { filters: [{ key: '../evil', operator: '=', value: ['x'] }] },
    });
    await flush();
    const msgs = sent(ws);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('filterChangeError');
  });
});
