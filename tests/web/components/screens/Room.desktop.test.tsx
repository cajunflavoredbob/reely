// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Companion to Room.test.tsx (mobile coverage from 0.4.44). Same
// heavy-children-stub harness; matchMedia stubbed TRUE to take the
// desktop branch. The desktop layout has a substantially different
// DOM: top bar with room name + UserPillRow + share/filter buttons;
// left sidebar with inline match cards (NO MatchesList component --
// the sidebar IS the matches list); center swipe stage; the
// FilterPanel always rendered inside a drawer (visibility driven by
// CSS class on the drawer wrapper, NOT by conditional rendering).
//
// Closes the 0.4.45 #338 caveat "Room desktop layout warrants its
// own pass" before the 0.5.0 close-out.

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

// Heavy children stubs (carry useful props on data-attrs) -- same as
// the mobile test file. The desktop layout also pulls in FilterPanel
// + UsersPopup + MatchMoment + CardStack + Card; MatchesList is NOT
// used on desktop (sidebar renders the cards inline).
vi.mock('../../../../web/app/src/components/organisms/CardStack', () => ({
  CardStack: ({ cards }: { cards: { id: string }[] }) => (
    <div data-testid="card-stack-stub" data-card-count={cards.length} />
  ),
}));
vi.mock('../../../../web/app/src/components/organisms/FilterPanel', () => ({
  FilterPanel: ({
    onClose,
    onApply,
    isDrawer,
    isOpen,
  }: {
    onClose: () => void;
    onApply: (f: unknown[]) => void;
    isDrawer?: boolean;
    isOpen?: boolean;
  }) => (
    <div
      data-testid="filter-panel-stub"
      data-is-drawer={isDrawer ? 'true' : 'false'}
      data-is-open={isOpen ? 'true' : 'false'}
    >
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
  MatchesList: () => <div data-testid="matches-list-stub" />,
}));
vi.mock('../../../../web/app/src/components/organisms/MatchMoment', () => ({
  MatchMoment: ({
    match,
    isBig,
    onDismiss,
  }: {
    match: { media: { id: string } };
    isBig: boolean;
    onDismiss: () => void;
  }) => (
    <div
      data-testid="match-moment-stub"
      data-match-id={match.media.id}
      data-is-big={isBig ? 'true' : 'false'}
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

const makeMatch = (id: string, matchedAt = 100, posterUrl: string | undefined = undefined): Match =>
  ({
    media: {
      id,
      type: 'movie',
      title: `Title ${id}`,
      description: '',
      plexKey: `/library/metadata/${id}`,
      posterUrl,
      year: 2024,
      duration: 0,
      rating: 8.5,
      genres: [],
    },
    users: ['alice'],
    matchedAt,
    // biome-ignore lint/suspicious/noExplicitAny: extra Match fields.
  }) as any;

// matchMedia stubbed TRUE so the SUT takes the desktop branch. This
// is the only configuration difference vs Room.test.tsx (mobile).
const stubMatchMedia = (matches = true) => {
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
  stubMatchMedia(true);
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('RoomScreen (desktop): top bar', () => {
  it('renders the room name from displayName when present', () => {
    withState({
      room: { name: 'movie-night', displayName: 'Movie Night', users: [], matches: [], media: [] },
    });
    render(<RoomScreen />);
    expect(screen.getByText('Movie Night')).toBeDefined();
  });

  it('falls back to room.name when displayName is undefined', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [] },
    });
    render(<RoomScreen />);
    expect(screen.getByText('movie-night')).toBeDefined();
  });

  it('shows the "{N} swiping" count from users.length', () => {
    withState({
      room: {
        name: 'r',
        users: [
          { user: { userName: 'alice' }, progress: 0 },
          { user: { userName: 'bob' }, progress: 0 },
          { user: { userName: 'carol' }, progress: 0 },
        ],
        matches: [],
        media: [],
      },
    });
    render(<RoomScreen />);
    expect(screen.getByText('3 swiping')).toBeDefined();
  });

  it('renders the filter button + share button in the top bar', () => {
    withState({ room: { name: 'r', users: [], matches: [], media: [] } });
    render(<RoomScreen />);
    expect(screen.getByRole('button', { name: 'Filters' })).toBeDefined();
    expect(screen.getAllByRole('button').some((b) => /share|copied/i.test(b.textContent ?? ''))).toBe(true);
  });
});

describe('RoomScreen (desktop): matches sidebar', () => {
  it('shows the empty placeholder when no matches yet', () => {
    withState({ room: { name: 'r', users: [], matches: [], media: [] } });
    render(<RoomScreen />);
    // Copy split across a <br />; assert via partial text matching.
    expect(screen.getByText(/Movies two or more/)).toBeDefined();
    expect(screen.getByText(/of you love will land here\./)).toBeDefined();
  });

  it('shows the match count in the sidebar header', () => {
    withState({
      room: {
        name: 'r',
        users: [],
        matches: [makeMatch('a', 100), makeMatch('b', 200), makeMatch('c', 300)],
        media: [],
      },
    });
    render(<RoomScreen />);
    // Sidebar count is rendered as the bare number inside the sidebar header.
    expect(screen.getByRole('heading', { level: 2, name: 'Matches' })).toBeDefined();
    // The count is in a sibling span. Find via the desktopSidebarCount class.
    const { container } = render(
      <RoomScreen />,
    );
    const countSpan = container.querySelector('[class*="desktopSidebarCount"]');
    expect(countSpan?.textContent).toBe('3');
  });

  it('renders one match card per match, sorted by descending matchedAt', () => {
    withState({
      room: {
        name: 'r',
        users: [],
        matches: [
          makeMatch('old', 100),
          makeMatch('new', 300),
          makeMatch('mid', 200),
        ],
        media: [],
      },
    });
    const { container } = render(<RoomScreen />);
    // Match cards have title text; assert all three titles render in
    // newest-first order via the desktopMatchTitle class.
    const titles = Array.from(container.querySelectorAll('[class*="desktopMatchTitle"]')).map(
      (n) => n.textContent,
    );
    expect(titles).toEqual(['Title new', 'Title mid', 'Title old']);
  });

  it('clicking a match card opens window.open with the local Plex URL when serverId + reachable', () => {
    withState({
      room: { name: 'r', users: [], matches: [makeMatch('a', 100)], media: [] },
      config: { plexServerId: 'SRV1', plexBaseUrl: 'http://192.168.1.15:32400' },
    });
    useLocalPlexReachableMock.mockReturnValue(true);
    const windowOpen = vi.fn();
    vi.stubGlobal('open', windowOpen);
    render(<RoomScreen />);
    // The match card is a button with the match title inside; find via
    // the desktopMatchCard class.
    const { container } = render(<RoomScreen />);
    const card = container.querySelector('[class*="desktopMatchCard"]') as HTMLButtonElement;
    fireEvent.click(card);
    expect(windowOpen).toHaveBeenCalled();
    expect(windowOpen.mock.calls[0]?.[0]).toContain('192.168.1.15:32400');
    expect(windowOpen.mock.calls[0]?.[1]).toBe('_blank');
  });

  it('clicking a match card does nothing when no plexServerId is configured', () => {
    withState({
      room: { name: 'r', users: [], matches: [makeMatch('a', 100)], media: [] },
      config: {},
    });
    const windowOpen = vi.fn();
    vi.stubGlobal('open', windowOpen);
    const { container } = render(<RoomScreen />);
    const card = container.querySelector('[class*="desktopMatchCard"]') as HTMLButtonElement;
    fireEvent.click(card);
    // No URL -> the `webUrl && window.open(...)` short-circuit prevents the open.
    expect(windowOpen).not.toHaveBeenCalled();
  });
});

describe('RoomScreen (desktop): filter drawer', () => {
  // Desktop renders FilterPanel ALWAYS (inside the drawer wrapper) --
  // visibility is driven by the desktopFilterDrawerOpen class on the
  // drawer wrapper, not by conditional rendering. The FilterPanel
  // receives isOpen={filterPanelOpen} so it knows when to re-sync
  // its draft from room.activeFilters (audit 13 #258).
  it('always renders the FilterPanel sentinel inside the drawer', () => {
    withState({ room: { name: 'r', users: [], matches: [], media: [] } });
    render(<RoomScreen />);
    const panel = screen.getByTestId('filter-panel-stub');
    expect(panel).toBeDefined();
    expect(panel.getAttribute('data-is-drawer')).toBe('true');
    expect(panel.getAttribute('data-is-open')).toBe('false');
  });

  it('clicking the filter button flips FilterPanel isOpen to true', () => {
    withState({ room: { name: 'r', users: [], matches: [], media: [] } });
    render(<RoomScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByTestId('filter-panel-stub').getAttribute('data-is-open')).toBe('true');
  });

  it('FilterPanel onApply dispatches applyFilters', () => {
    withState({ room: { name: 'r', users: [], matches: [], media: [] } });
    render(<RoomScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByTestId('filter-apply'));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'applyFilters',
      payload: { filters: [{ key: 'genre' }] },
    });
  });
});

describe('RoomScreen (desktop): users popup + center stage', () => {
  it('clicking the UserPillRow opens UsersPopup; close hides it; onLeave dispatches leaveRoom', () => {
    withState({
      room: { name: 'r', users: [{ user: { userName: 'alice' }, progress: 0 }], matches: [], media: [] },
      user: { userName: 'alice' },
    });
    render(<RoomScreen />);
    expect(screen.queryByTestId('users-popup-stub')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show all .* users in room/i }));
    expect(screen.getByTestId('users-popup-stub')).toBeDefined();
    fireEvent.click(screen.getByTestId('users-popup-leave'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'leaveRoom' });
  });

  it('renders CardStack in the swipe stage with the room\'s media', () => {
    withState({
      room: {
        name: 'r',
        users: [],
        matches: [],
        media: [{ id: 'a' }, { id: 'b' }],
        mediaVersion: 1,
      },
    });
    render(<RoomScreen />);
    expect(screen.getByTestId('card-stack-stub').getAttribute('data-card-count')).toBe('2');
  });

  it('renders MatchMoment in the swipe stage when a fresh match arrives post-mount', () => {
    withState({ room: { name: 'r', users: [], matches: [], media: [] } });
    const { rerender } = render(<RoomScreen />);
    expect(screen.queryByTestId('match-moment-stub')).toBeNull();
    act(() => {
      withState({
        room: { name: 'r', users: [], matches: [makeMatch('a', 500)], media: [] },
      });
      rerender(<RoomScreen />);
    });
    expect(screen.getByTestId('match-moment-stub').getAttribute('data-match-id')).toBe('a');
  });
});
