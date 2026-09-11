// @vitest-environment jsdom
//
// biome-ignore-all lint/style/noNonNullAssertion: a missing ancestor throws a TypeError, as actionable as an assertion failure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Login reads user/error/room/config/connectionStatus from the store and
// dispatches login + joinOrCreateRoom. The sanitize utils are pure, so they
// run unmocked.
const { useStoreMock } = vi.hoisted(() => ({ useStoreMock: vi.fn() }));

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  useDispatch: vi.fn(),
  useSelector: vi.fn(),
  createStore: vi.fn(),
}));

import { LoginScreen } from '../../../../web/app/src/components/screens/Login';

let dispatch: ReturnType<typeof vi.fn>;

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([
    {
      user: undefined,
      error: undefined,
      room: undefined,
      config: undefined,
      connectionStatus: 'connected',
      ...slice,
    },
    dispatch,
  ]);
};

// The lazy useState initializer reads location.search once at mount. jsdom's
// location is real but not assignable, so override it via defineProperty.
const setRoomNameInUrl = (roomName: string | null) => {
  const search = roomName === null ? '' : `?roomName=${encodeURIComponent(roomName)}`;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, search, href: `https://reely.example.com/${search}` },
  });
};

beforeEach(() => {
  dispatch = vi.fn();
  useStoreMock.mockReset();
  withState();
  localStorage.clear();
  setRoomNameInUrl(null);
});

afterEach(() => {
  cleanup();
});

describe('LoginScreen: initial UI from mount-time inputs', () => {
  it('shows the name input (no chip) when no userName is stored', () => {
    render(<LoginScreen />);
    expect(screen.getByLabelText('Your name')).toBeDefined();
    expect(screen.queryByText('Change')).toBeNull();
  });

  it('shows the name chip (not the input) when a userName is stored', () => {
    localStorage.setItem('userName', 'alice');
    render(<LoginScreen />);
    expect(screen.queryByLabelText('Your name')).toBeNull();
    expect(screen.getByText('Change')).toBeDefined();
    expect(screen.getByText('alice')).toBeDefined();
  });

  it('seeds the room input from ?roomName in the URL (deep-link case)', () => {
    setRoomNameInUrl('movie-night');
    render(<LoginScreen />);
    const roomInput = screen.getByLabelText('Room name') as HTMLInputElement;
    expect(roomInput.value).toBe('movie-night');
  });

  it('leaves the room input empty when no ?roomName is present', () => {
    render(<LoginScreen />);
    expect((screen.getByLabelText('Room name') as HTMLInputElement).value).toBe('');
  });

  it('renders the headline + subline', () => {
    render(<LoginScreen />);
    expect(screen.getByText("pick tonight's screening.")).toBeDefined();
    expect(screen.getByText(/pick a room/i)).toBeDefined();
  });
});

describe('LoginScreen: server chip + error box (store-driven)', () => {
  it('hides the server chip when config has no serverName', () => {
    withState({ config: undefined });
    const { container } = render(<LoginScreen />);
    expect(container.querySelector('[class*="serverChip"]')).toBeNull();
  });

  it('shows the server chip with name + status dot when config has serverName', () => {
    withState({
      config: { serverName: 'My Plex', providerType: 'plex' },
      connectionStatus: 'connected',
    });
    const { container } = render(<LoginScreen />);
    expect(screen.getByText('My Plex')).toBeDefined();
    // The status dot carries data-status for CSS coloring.
    const dot = container.querySelector('[data-status]');
    expect(dot?.getAttribute('data-status')).toBe('connected');
  });

  it('renders the error message in the error box when error is set', () => {
    withState({ error: { message: 'Login failed' } });
    render(<LoginScreen />);
    expect(screen.getByText('Login failed')).toBeDefined();
  });

  // A message-less error must not render "undefined".
  it('renders a generic fallback when the error has no message', () => {
    withState({ error: {} });
    render(<LoginScreen />);
    expect(screen.getByText('Something went wrong')).toBeDefined();
  });
});

describe('LoginScreen: submit + validation', () => {
  it('shows "Required" + opens edit mode when name is empty at submit', () => {
    localStorage.setItem('userName', 'alice');
    render(<LoginScreen />);
    fireEvent.click(screen.getByText('Change').closest('button')!);
    const nameInput = screen.getByLabelText('Your name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '' } });
    fireEvent.submit(nameInput.closest('form')!);
    // Name and room both fail, so "Required" appears twice.
    expect(screen.getAllByText('Required').length).toBeGreaterThan(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('shows "Required" on the room input when room is empty at submit', () => {
    render(<LoginScreen />);
    const nameInput = screen.getByLabelText('Your name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'alice' } });
    fireEvent.submit(nameInput.closest('form')!);
    expect(screen.getAllByText('Required').length).toBeGreaterThan(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches login (and captures pendingJoinRoom) when no user is logged in yet', () => {
    render(<LoginScreen />);
    const nameInput = screen.getByLabelText('Your name') as HTMLInputElement;
    const roomInput = screen.getByLabelText('Room name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'alice' } });
    fireEvent.change(roomInput, { target: { value: 'movie-night' } });
    fireEvent.submit(nameInput.closest('form')!);
    expect(dispatch).toHaveBeenCalledWith({ type: 'login', payload: { userName: 'alice' } });
    // joinOrCreateRoom is deferred to the post-login effect.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('dispatches joinOrCreateRoom directly when already logged in under the same name', () => {
    localStorage.setItem('userName', 'alice');
    withState({ user: { userName: 'alice' } });
    render(<LoginScreen />);
    const roomInput = screen.getByLabelText('Room name') as HTMLInputElement;
    fireEvent.change(roomInput, { target: { value: 'movie-night' } });
    fireEvent.submit(roomInput.closest('form')!);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'joinOrCreateRoom',
      payload: { roomName: 'movie-night' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // An edited chip name differs from the server-side identity, so login has to
  // run again or the join lands under the old username.
  it('re-dispatches login when the cached chip was edited to a different name', () => {
    localStorage.setItem('userName', 'alice');
    withState({ user: { userName: 'alice' } });
    render(<LoginScreen />);
    fireEvent.click(screen.getByText('Change').closest('button')!);
    const nameInput = screen.getByLabelText('Your name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'alice2' } });
    const roomInput = screen.getByLabelText('Room name') as HTMLInputElement;
    fireEvent.change(roomInput, { target: { value: 'movie-night' } });
    fireEvent.submit(roomInput.closest('form')!);
    expect(dispatch).toHaveBeenCalledWith({ type: 'login', payload: { userName: 'alice2' } });
  });
});

describe('LoginScreen: deferred-join effect', () => {
  // The effect joins with the room name snapshotted at submit, not whatever
  // the input shows. It holds a string|null rather than a boolean so typing
  // between submit and login-success cannot change the room joined.
  it('fires the deferred joinOrCreateRoom when user appears in the store after a pending login', () => {
    const { rerender } = render(<LoginScreen />);
    const nameInput = screen.getByLabelText('Your name') as HTMLInputElement;
    const roomInput = screen.getByLabelText('Room name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'alice' } });
    fireEvent.change(roomInput, { target: { value: 'movie-night' } });
    fireEvent.submit(nameInput.closest('form')!);
    expect(dispatch).toHaveBeenCalledWith({ type: 'login', payload: { userName: 'alice' } });

    // Login succeeds: user lands in the store.
    act(() => {
      withState({ user: { userName: 'alice' } });
      rerender(<LoginScreen />);
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'joinOrCreateRoom',
      payload: { roomName: 'movie-night' },
    });
  });

  // The room input stays editable through the login round-trip, so this is the
  // assertion that actually distinguishes the captured string from a boolean
  // flag plus a live read of `roomName`.
  it('joins the room captured at submit, not what the input holds when login lands', () => {
    const { rerender } = render(<LoginScreen />);
    const nameInput = screen.getByLabelText('Your name') as HTMLInputElement;
    const roomInput = screen.getByLabelText('Room name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'alice' } });
    fireEvent.change(roomInput, { target: { value: 'movie-night' } });
    fireEvent.submit(nameInput.closest('form')!);

    // The user keeps typing while the login is in flight.
    fireEvent.change(roomInput, { target: { value: 'somewhere-else' } });

    act(() => {
      withState({ user: { userName: 'alice' } });
      rerender(<LoginScreen />);
    });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'joinOrCreateRoom',
      payload: { roomName: 'movie-night' },
    });
    expect(dispatch).not.toHaveBeenCalledWith({
      type: 'joinOrCreateRoom',
      payload: { roomName: 'somewhere-else' },
    });
  });

  // Clearing the slot on error stops a later auto-set of `user` (a WS reconnect
  // restoring the cached session) from firing a stale join unprompted.
  it('clears the deferred-join slot when an error appears (no stale fire on later user-set)', () => {
    const { rerender } = render(<LoginScreen />);
    const nameInput = screen.getByLabelText('Your name') as HTMLInputElement;
    const roomInput = screen.getByLabelText('Room name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'alice' } });
    fireEvent.change(roomInput, { target: { value: 'movie-night' } });
    fireEvent.submit(nameInput.closest('form')!);
    expect(dispatch).toHaveBeenCalledTimes(1); // login

    // Error arrives.
    act(() => {
      withState({ error: { message: 'nope' } });
      rerender(<LoginScreen />);
    });
    dispatch.mockClear();

    // A reconnect sets user later; the cleared slot must swallow it.
    act(() => {
      withState({ user: { userName: 'alice' } });
      rerender(<LoginScreen />);
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('LoginScreen: CTA button states', () => {
  it('shows "start screening" by default', () => {
    render(<LoginScreen />);
    expect(screen.getByRole('button', { name: /start screening/i })).toBeDefined();
  });

  it('shows "joining…" when a room exists but is not yet joined', () => {
    withState({ room: { name: 'movie-night', joined: false } });
    render(<LoginScreen />);
    expect(screen.getByRole('button', { name: /joining/i })).toBeDefined();
  });

  it('disables the CTA when the form is invalid (empty name/room)', () => {
    render(<LoginScreen />);
    const cta = screen.getByRole('button', { name: /start screening/i }) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
  });

  it('disables the CTA while joining (room exists but not joined yet)', () => {
    localStorage.setItem('userName', 'alice');
    withState({
      user: { userName: 'alice' },
      room: { name: 'movie-night', joined: false },
    });
    setRoomNameInUrl('movie-night');
    render(<LoginScreen />);
    const cta = screen.getByRole('button', { name: /joining/i }) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
  });
});

describe('LoginScreen: chip <-> input transitions', () => {
  it('clicking the chip opens the name input (the chip swaps for the input)', () => {
    localStorage.setItem('userName', 'alice');
    render(<LoginScreen />);
    expect(screen.queryByLabelText('Your name')).toBeNull(); // chip mode
    fireEvent.click(screen.getByText('Change').closest('button')!);
    expect(screen.getByLabelText('Your name')).toBeDefined(); // edit mode
  });

  it('pressing Escape in the edit input restores the pre-edit name and returns to chip view', () => {
    localStorage.setItem('userName', 'alice');
    render(<LoginScreen />);
    fireEvent.click(screen.getByText('Change').closest('button')!);
    const nameInput = screen.getByLabelText('Your name') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'alice2' } });
    fireEvent.keyDown(nameInput, { key: 'Escape' });
    // Chip mode again, original name intact.
    expect(screen.queryByLabelText('Your name')).toBeNull();
    expect(screen.getByText('alice')).toBeDefined();
  });
});
