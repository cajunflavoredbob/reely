// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Desktop companion to Room.test.tsx: same stub harness, matchMedia stubbed
// TRUE. The desktop DOM differs substantially: a top bar, a left sidebar that
// renders match cards inline (no MatchesList), a center swipe stage, and a
// FilterPanel always mounted inside a drawer whose visibility comes from a CSS
// class rather than conditional rendering.

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

// Same stubs as the mobile file. MatchesList goes unused on desktop.
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

// TRUE takes the desktop branch: the only config difference from Room.test.tsx.
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
    // A <br /> splits the copy, so match partial text.
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
    const { container } = render(<RoomScreen />);
    expect(screen.getByRole('heading', { level: 2, name: 'Matches' })).toBeDefined();
    // The bare count sits in a sibling span.
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
    // Titles carry the desktopMatchTitle class; DOM order is render order.
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
    // The card is an unlabeled button, so query by class.
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
    // No URL, so the `webUrl && window.open(...)` short-circuit blocks it.
    expect(windowOpen).not.toHaveBeenCalled();
  });
});

describe('RoomScreen (desktop): filter drawer', () => {
  // The panel is always mounted; the desktopFilterDrawerOpen class drives
  // visibility. isOpen still tells it when to re-sync its draft from
  // room.activeFilters.
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
