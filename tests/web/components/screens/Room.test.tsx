// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Room is the swipe-screen container. It pulls in CardStack + FilterPanel
// + UsersPopup + MatchesList + MatchMoment + Card -- all of which have
// their own coverage in earlier batches. We stub the heavy children as
// sentinels (carrying their useful props on data-attrs) so this test
// focuses on Room's own orchestration: route gating, popup toggle
// wiring, share-button clipboard fallback, match-celebration queue,
// requestFilters prefetch.
//
// Tests cover the MOBILE layout only -- matchMedia is stubbed to return
// false for `(min-width: 900px)`. Desktop is a substantially different
// layout that warrants its own pass if/when the audit calls for it.
const {
  useStoreMock,
  useLocalPlexReachableMock,
} = vi.hoisted(() => ({
  useStoreMock: vi.fn(),
  useLocalPlexReachableMock: vi.fn(),
}));

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  useDispatch: vi.fn(),
  useSelector: vi.fn(),
  createStore: vi.fn(),
}));

vi.mock('../../../../web/app/src/utils/plexLinks', async () => {
  const actual = await vi.importActual<typeof import('../../../../web/app/src/utils/plexLinks')>(
    '../../../../web/app/src/utils/plexLinks',
  );
  return { ...actual, useLocalPlexReachable: useLocalPlexReachableMock };
});

// Stub the heavy children as sentinels carrying the props we care about
// as data-attrs. Where a callback prop matters for an interaction test
// (FilterPanel.onClose, UsersPopup.onLeave, etc.), the sentinel exposes
// a button that invokes it so the test can fire it.
vi.mock('../../../../web/app/src/components/organisms/CardStack', () => ({
  CardStack: ({ cards }: { cards: { id: string }[] }) => (
    <div data-testid="card-stack-stub" data-card-count={cards.length} />
  ),
}));
vi.mock('../../../../web/app/src/components/organisms/FilterPanel', () => ({
  FilterPanel: ({ onClose, onApply }: { onClose: () => void; onApply: (f: unknown[]) => void }) => (
    <div data-testid="filter-panel-stub">
      <button type="button" data-testid="filter-close" onClick={onClose}>
        close
      </button>
      <button
        type="button"
        data-testid="filter-apply"
        onClick={() => onApply([{ key: 'genre' }])}
      >
        apply
      </button>
    </div>
  ),
}));
vi.mock('../../../../web/app/src/components/organisms/UsersPopup', () => ({
  UsersPopup: ({ onClose, onLeave }: { onClose: () => void; onLeave: () => void }) => (
    <div data-testid="users-popup-stub">
      <button type="button" data-testid="users-popup-close" onClick={onClose}>
        close
      </button>
      <button type="button" data-testid="users-popup-leave" onClick={onLeave}>
        leave
      </button>
    </div>
  ),
}));
vi.mock('../../../../web/app/src/components/organisms/MatchesList', () => ({
  MatchesList: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="matches-list-stub">
      <button type="button" data-testid="matches-list-close" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));
vi.mock('../../../../web/app/src/components/organisms/MatchMoment', () => ({
  MatchMoment: ({
    match,
    isBig,
    onDismiss,
    replaced,
  }: {
    match: { media: { id: string } };
    isBig: boolean;
    onDismiss: () => void;
    // 0.5.7: stack model. Non-top entries get replaced=true; the stub
    // surfaces it as a data attribute so tests can assert on it.
    replaced?: boolean;
  }) => (
    <div
      data-testid="match-moment-stub"
      data-match-id={match.media.id}
      data-is-big={isBig ? 'true' : 'false'}
      data-replaced={replaced ? 'true' : 'false'}
    >
      <button type="button" data-testid="match-dismiss" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  ),
}));
vi.mock('../../../../web/app/src/components/molecules/Card', () => ({
  Card: ({ media }: { media: { id: string } }) => <div data-testid={`card-${media.id}`} />,
}));

import { RoomScreen } from '../../../../web/app/src/components/screens/Room';
import type { Match } from '../../../../types/reely';

let dispatch: ReturnType<typeof vi.fn>;

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([
    {
      room: undefined,
      user: undefined,
      createRoom: undefined,
      config: {},
      ...slice,
    },
    dispatch,
  ]);
};

const makeMatch = (id: string, matchedAt = 100, posterUrl: string | undefined = undefined): Match => ({
  media: {
    id,
    type: 'movie',
    title: `Title ${id}`,
    description: '',
    plexKey: `/library/metadata/${id}`,
    posterUrl,
    year: 2024,
    duration: 0,
    rating: 0,
    genres: [],
  },
  users: ['alice'],
  matchedAt,
  // biome-ignore lint/suspicious/noExplicitAny: extra Match fields.
} as any);

// matchMedia + ResizeObserver aren't in jsdom by default. matchMedia
// returns false for the desktop breakpoint so all tests run against the
// mobile layout (simpler + most behaviors are shared).
const stubMatchMedia = (matches = false) => {
  vi.stubGlobal('matchMedia', () =>
    ({
      matches,
      media: '',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList,
  );
};
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  dispatch = vi.fn();
  useStoreMock.mockReset();
  useLocalPlexReachableMock.mockReset().mockReturnValue(undefined);
  withState();
  stubMatchMedia(false);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('RoomScreen: no-room early return', () => {
  it('renders ErrorMessage when no room is in the store', () => {
    withState({ room: undefined });
    render(<RoomScreen />);
    expect(screen.getByText('No Room!')).toBeDefined();
    // None of the heavy children should render in the no-room state.
    expect(screen.queryByTestId('card-stack-stub')).toBeNull();
  });
});

describe('RoomScreen: mobile layout basics', () => {
  it('renders the CardStack with the room\'s media + key tied to mediaVersion', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [
        { id: 'a' }, { id: 'b' }, { id: 'c' },
      ], mediaVersion: 1 },
    });
    render(<RoomScreen />);
    const stack = screen.getByTestId('card-stack-stub');
    expect(stack.getAttribute('data-card-count')).toBe('3');
  });

  it('renders the mobile match strip when matches are present', () => {
    withState({
      room: {
        name: 'movie-night',
        users: [],
        matches: [makeMatch('a', 100)],
        media: [],
      },
    });
    render(<RoomScreen />);
    // Match strip is a div with role="button" + aria-label including the count.
    expect(screen.getByRole('button', { name: /1 matches.*tap to view/i })).toBeDefined();
  });

  it('renders the empty placeholder when no matches yet', () => {
    withState({ room: { name: 'movie-night', users: [], matches: [], media: [] } });
    render(<RoomScreen />);
    expect(screen.getByText('matches will appear here as you swipe')).toBeDefined();
    expect(screen.queryByRole('button', { name: /tap to view/i })).toBeNull();
  });
});

describe('RoomScreen: popup wiring', () => {
  it('clicking the filter button opens FilterPanel; onClose hides it', () => {
    withState({ room: { name: 'movie-night', users: [], matches: [], media: [] } });
    render(<RoomScreen />);
    // FilterPanel not rendered until open.
    expect(screen.queryByTestId('filter-panel-stub')).toBeNull();
    // FilterButton always carries aria-label="Filters" (mobile + desktop).
    // aria-expanded is desktop-only so we can't filter by that here.
    const filterButton = screen.getByRole('button', { name: 'Filters' });
    fireEvent.click(filterButton);
    expect(screen.getByTestId('filter-panel-stub')).toBeDefined();
    fireEvent.click(screen.getByTestId('filter-close'));
    expect(screen.queryByTestId('filter-panel-stub')).toBeNull();
  });

  it('FilterPanel apply -> dispatches applyFilters with the payload', () => {
    withState({ room: { name: 'movie-night', users: [], matches: [], media: [] } });
    render(<RoomScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByTestId('filter-apply'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre' }] },
    });
  });

  it('clicking the UserPillRow opens UsersPopup; close hides it', () => {
    withState({
      room: { name: 'movie-night', users: [{ user: { userName: 'alice' }, progress: 0 }], matches: [], media: [] },
      user: { userName: 'alice' },
    });
    render(<RoomScreen />);
    expect(screen.queryByTestId('users-popup-stub')).toBeNull();
    // UserPillRow renders as a button with an aria-label "Show all N users in room".
    fireEvent.click(screen.getByRole('button', { name: /Show all .* users in room/i }));
    expect(screen.getByTestId('users-popup-stub')).toBeDefined();
    fireEvent.click(screen.getByTestId('users-popup-close'));
    expect(screen.queryByTestId('users-popup-stub')).toBeNull();
  });

  it('UsersPopup onLeave dispatches leaveRoom', () => {
    withState({
      room: { name: 'movie-night', users: [{ user: { userName: 'alice' }, progress: 0 }], matches: [], media: [] },
      user: { userName: 'alice' },
    });
    render(<RoomScreen />);
    fireEvent.click(screen.getByRole('button', { name: /Show all .* users in room/i }));
    fireEvent.click(screen.getByTestId('users-popup-leave'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'leaveRoom' });
  });

  it('clicking the mobile match strip opens MatchesList', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [makeMatch('a')], media: [] },
    });
    render(<RoomScreen />);
    expect(screen.queryByTestId('matches-list-stub')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /1 matches.*tap to view/i }));
    expect(screen.getByTestId('matches-list-stub')).toBeDefined();
  });
});

describe('RoomScreen: requestFilters prefetch', () => {
  // The filter-catalog prefetch lets the filterChangeApplied toast resolve
  // field titles even when the user hasn't opened the panel yet.
  it('dispatches requestFilters on mount when createRoom.availableFilters is absent', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [] },
      createRoom: { availableFilters: undefined },
    });
    render(<RoomScreen />);
    expect(dispatch).toHaveBeenCalledWith({ type: 'requestFilters' });
  });

  it('does NOT dispatch requestFilters when availableFilters is already present', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [] },
      createRoom: { availableFilters: { filters: [] } },
    });
    render(<RoomScreen />);
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'requestFilters' });
  });
});

describe('RoomScreen: match-celebration stack (0.5.7)', () => {
  // 0.5.7: model changed from a FIFO queue (audit 11 #178: oldest first,
  // advance on dismiss, every match got its own moment) to a stack where
  // the newest is on top + the rest fade out via .toastReplaced. The
  // rationale: per the owner's feedback, new match notifications should
  // slide down on top of any existing one and replace it. See Room.tsx
  // pendingStack comment for the full trade-off (rapid back-to-back
  // matches no longer each get a 3s celebration window; the matches
  // list is the canonical record).
  // Audit 12 #244 (room-change reseed) is unchanged by this model swap.

  it('does NOT celebrate matches that were present at first mount (they are the join\'s previousMatches)', () => {
    // Initial mount: room.matches has two matches. Both are "previous";
    // none should pop a celebration.
    withState({
      room: {
        name: 'movie-night',
        users: [],
        matches: [makeMatch('a', 100), makeMatch('b', 200)],
        media: [],
      },
    });
    render(<RoomScreen />);
    expect(screen.queryByTestId('match-moment-stub')).toBeNull();
  });

  it('celebrates a fresh match that appears AFTER mount', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [] },
    });
    const { rerender } = render(<RoomScreen />);
    expect(screen.queryByTestId('match-moment-stub')).toBeNull();
    // New match arrives.
    act(() => {
      withState({
        room: {
          name: 'movie-night',
          users: [],
          matches: [makeMatch('a', 500)],
          media: [],
        },
      });
      rerender(<RoomScreen />);
    });
    expect(screen.getByTestId('match-moment-stub')).toBeDefined();
    expect(screen.getByTestId('match-moment-stub').getAttribute('data-match-id')).toBe('a');
    // First celebration of the session gets the big overlay.
    expect(screen.getByTestId('match-moment-stub').getAttribute('data-is-big')).toBe('true');
  });

  // 0.5.7: when multiple fresh matches arrive in the same tick, ALL
  // render simultaneously (stack model). DOM order = stack order; the
  // last-rendered is the visual top + the only one that's active
  // (dismissable, can be big). The rest carry replaced=true so the
  // .toastReplaced fade kicks in. The top gets the big-celebration
  // overlay (first of the session); older entries cannot be big.
  // Also asserts the dismiss path: clicking the top's dismiss clears
  // the entire stack in one shot (older entries were already faded
  // invisible -- unmounting them with the dismissed top is a visual
  // no-op).
  it('stacks newest on top, marks older entries replaced, and clears whole stack on top dismiss', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [] },
    });
    const { rerender } = render(<RoomScreen />);
    // Two fresh matches arrive together.
    act(() => {
      withState({
        room: {
          name: 'movie-night',
          users: [],
          matches: [makeMatch('a', 500), makeMatch('b', 600)],
          media: [],
        },
      });
      rerender(<RoomScreen />);
    });
    // Both render. Order in DOM = stack order; newest (b) is last. In
    // jsdom, window.matchMedia returns matches=false so only the mobile
    // branch renders -- one stub per stack entry. (If we ever add a
    // desktop test variant by stubbing matchMedia, the count would
    // double.)
    const stubs = screen.getAllByTestId('match-moment-stub');
    expect(stubs.length).toBe(2);
    // `a` (older, underneath): not top, so isBig=false + replaced=true.
    expect(stubs[0].getAttribute('data-match-id')).toBe('a');
    expect(stubs[0].getAttribute('data-is-big')).toBe('false');
    expect(stubs[0].getAttribute('data-replaced')).toBe('true');
    // `b` (newer, top): isBig=true (first celebration of session),
    // replaced=false.
    expect(stubs[1].getAttribute('data-match-id')).toBe('b');
    expect(stubs[1].getAttribute('data-is-big')).toBe('true');
    expect(stubs[1].getAttribute('data-replaced')).toBe('false');
    // Dismiss the TOP (b). The top's dismiss button fires
    // dismissPending which clears the whole stack.
    const bDismiss = stubs[1].querySelector('[data-testid="match-dismiss"]') as HTMLButtonElement;
    fireEvent.click(bDismiss);
    expect(screen.queryAllByTestId('match-moment-stub').length).toBe(0);
  });
});

describe('RoomScreen: Share button (clipboard + fallbacks)', () => {
  beforeEach(() => {
    withState({ room: { name: 'movie-night', users: [], matches: [], media: [] } });
    // Stub location so the share URL has a known base.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        href: 'https://reely.example.com/?stale=keep',
        search: '?stale=keep',
      },
    });
  });

  // Find the share button via its title text -- the ShareButton helper
  // inside Room.tsx renders a button containing the visible label.
  const clickShareButton = () => {
    // ShareButton's label text alternates between "Share" and "Copied!"
    // and is also "Share link copied" via aria-label. Use the share button
    // by its position: it's the first button in the mobile bottom bar
    // (which is also adjacent to the filter button). Match aria-label or
    // visible text containing 'Share'.
    const share = screen.getAllByRole('button').find((b) => /share|copied/i.test(b.textContent ?? ''));
    if (!share) throw new Error('Share button not found');
    fireEvent.click(share);
  };

  it('uses navigator.clipboard.writeText when available + sets "Copied!" state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<RoomScreen />);
    clickShareButton();
    // Let the async writeText resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain('roomName=movie-night');
    // The "Copied!" indicator is up. Both labels are always in the DOM
    // (width-stable button -- 0.5.9 fix); the active one carries
    // aria-hidden="false", so query that specifically rather than
    // textContent (which now always contains both strings).
    const share = screen.getAllByRole('button').find((b) => /share|copied/i.test(b.textContent ?? ''));
    const visibleLabel = share?.querySelector<HTMLElement>('span[aria-hidden="false"]');
    expect(visibleLabel?.textContent).toBe('Copied!');
  });

  // No clipboard + legacy execCommand fails -> window.prompt fallback so
  // the user can copy the link by hand.
  it('falls back to window.prompt when neither clipboard.writeText nor execCommand succeeds', async () => {
    // No clipboard.
    vi.stubGlobal('navigator', {});
    // execCommand returns false (jsdom default; pin explicitly).
    document.execCommand = vi.fn().mockReturnValue(false);
    const promptSpy = vi.fn();
    vi.stubGlobal('prompt', promptSpy);
    render(<RoomScreen />);
    clickShareButton();
    await new Promise((r) => setTimeout(r, 0));
    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(promptSpy.mock.calls[0]?.[1]).toContain('roomName=movie-night');
  });
});
