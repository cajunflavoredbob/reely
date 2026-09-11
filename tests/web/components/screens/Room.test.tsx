// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Swipe-screen container. The heavy children are stubbed as sentinels (props
// on data-attrs, callbacks exposed as buttons) so these focus on Room's own
// orchestration: route gating, popup wiring, share clipboard fallbacks, the
// match-celebration stack, and the requestFilters prefetch. Each child has its
// own test file.
//
// Mobile layout only: matchMedia returns false for `(min-width: 900px)`.
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
    // Non-top stack entries get replaced=true; surfaced as a data attr.
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

// jsdom ships neither. Returning false for the desktop breakpoint keeps every
// test on the mobile layout.
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
    // No heavy children in the no-room state.
    expect(screen.queryByTestId('card-stack-stub')).toBeNull();
  });
});

describe('RoomScreen: mobile layout basics', () => {
  it('renders the CardStack with the room\'s media', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [
        { id: 'a' }, { id: 'b' }, { id: 'c' },
      ], mediaVersion: 1 },
    });
    render(<RoomScreen />);
    const stack = screen.getByTestId('card-stack-stub');
    expect(stack.getAttribute('data-card-count')).toBe('3');
  });

  // The real CardStack is memoized with a `() => true` comparator, so a bumped
  // `key` is the ONLY thing that can hand it a deck after an applyFilters.
  // Node identity is the proof: React reuses the host node on a re-render and
  // creates a fresh one when the key changes, so dropping the key (or pinning
  // it to a constant) turns the second assertion red.
  it('remounts the CardStack when room.mediaVersion changes', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [{ id: 'a' }], mediaVersion: 1 },
    });
    const { rerender } = render(<RoomScreen />);
    const first = screen.getByTestId('card-stack-stub');

    // Same mediaVersion, different media: same node, patched in place.
    act(() => {
      withState({
        room: {
          name: 'movie-night', users: [], matches: [],
          media: [{ id: 'a' }, { id: 'b' }], mediaVersion: 1,
        },
      });
      rerender(<RoomScreen />);
    });
    expect(screen.getByTestId('card-stack-stub')).toBe(first);
    expect(first.getAttribute('data-card-count')).toBe('2');

    // Bumped mediaVersion: a brand-new node, i.e. a remount.
    act(() => {
      withState({
        room: {
          name: 'movie-night', users: [], matches: [],
          media: [{ id: 'x' }, { id: 'y' }, { id: 'z' }], mediaVersion: 2,
        },
      });
      rerender(<RoomScreen />);
    });
    const second = screen.getByTestId('card-stack-stub');
    expect(second).not.toBe(first);
    expect(second.getAttribute('data-card-count')).toBe('3');
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
    // The strip is a role=button whose aria-label carries the count.
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
    expect(screen.queryByTestId('filter-panel-stub')).toBeNull();
    // aria-expanded is desktop-only, so match on the label.
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
  const populatedCatalog = {
    filters: [{ key: 'genre', title: 'Genre', type: 'string' }],
    filterTypes: {},
  };

  // Lets the filterChangeApplied toast resolve field titles before the panel
  // has ever been opened.
  it('dispatches requestFilters on mount when createRoom.availableFilters is absent', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [] },
      createRoom: { availableFilters: undefined },
    });
    render(<RoomScreen />);
    expect(dispatch).toHaveBeenCalledWith({ type: 'requestFilters' });
  });

  it('does NOT dispatch requestFilters when a populated catalog is already present', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [] },
      createRoom: { availableFilters: populatedCatalog },
    });
    render(<RoomScreen />);
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'requestFilters' });
  });

  // requestFiltersError latches availableFilters to an empty set so the panel
  // stops spinning, which also makes "present" indistinguishable from "failed"
  // unless emptiness counts as absent.
  it('treats the latched empty catalog as absent and still asks on mount', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [] },
      createRoom: { availableFilters: { filters: [], filterTypes: {} } },
    });
    render(<RoomScreen />);
    expect(dispatch).toHaveBeenCalledWith({ type: 'requestFilters' });
  });

  it('retries on the panel open transition while the catalog is still empty', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [] },
      createRoom: { availableFilters: { filters: [], filterTypes: {} } },
    });
    render(<RoomScreen />);
    const afterMount = dispatch.mock.calls.filter(
      ([a]) => a.type === 'requestFilters',
    ).length;
    expect(afterMount).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(
      dispatch.mock.calls.filter(([a]) => a.type === 'requestFilters').length,
    ).toBe(2);

    // Closing is not a retry opportunity, so it must not fire a third.
    fireEvent.click(screen.getByTestId('filter-close'));
    expect(
      dispatch.mock.calls.filter(([a]) => a.type === 'requestFilters').length,
    ).toBe(2);
  });

  it('does NOT retry on open once the catalog has arrived', () => {
    withState({
      room: { name: 'movie-night', users: [], matches: [], media: [] },
      createRoom: { availableFilters: populatedCatalog },
    });
    render(<RoomScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'requestFilters' });
  });
});

describe('RoomScreen: Escape arbitration', () => {
  // useEscape binds every handler to window with no arbitration, so an
  // ungated handler here would run on the same keystroke as the celebration's
  // and silently discard the user's in-progress filter draft.
  it('closes the filter panel on Escape when nothing is layered over it', () => {
    withState({ room: { name: 'movie-night', users: [], matches: [], media: [] } });
    render(<RoomScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByTestId('filter-panel-stub')).toBeDefined();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('filter-panel-stub')).toBeNull();
  });

  it('leaves the filter panel open on Escape while a match celebration is up', () => {
    withState({ room: { name: 'movie-night', users: [], matches: [], media: [] } });
    const { rerender } = render(<RoomScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    act(() => {
      withState({
        room: { name: 'movie-night', users: [], matches: [makeMatch('a', 500)], media: [] },
      });
      rerender(<RoomScreen />);
    });
    expect(screen.getByTestId('match-moment-stub')).toBeDefined();

    fireEvent.keyDown(window, { key: 'Escape' });
    // The celebration owns that press; the draft in the panel survives.
    expect(screen.getByTestId('filter-panel-stub')).toBeDefined();

    // With the celebration gone, the next press closes the panel as usual.
    fireEvent.click(screen.getByTestId('match-dismiss'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('filter-panel-stub')).toBeNull();
  });

  it('leaves the filter panel open on Escape while the users popup is up', () => {
    withState({
      room: {
        name: 'movie-night',
        users: [{ user: { userName: 'alice' }, progress: 0 }],
        matches: [],
        media: [],
      },
      user: { userName: 'alice' },
    });
    render(<RoomScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: /Show all .* users in room/i }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('filter-panel-stub')).toBeDefined();
  });
});

describe('RoomScreen: match-celebration stack (0.5.7)', () => {
  // A stack, not a FIFO queue: the newest match sits on top and the rest fade
  // out via .toastReplaced. Rapid back-to-back matches therefore do not each
  // get a 3s window; the matches list is the canonical record. See Room.tsx's
  // pendingStack comment.

  it('does NOT celebrate matches that were present at first mount (they are the join\'s previousMatches)', () => {
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
    // The session's first celebration gets the big overlay.
    expect(screen.getByTestId('match-moment-stub').getAttribute('data-is-big')).toBe('true');
  });

  // Fresh matches arriving in one tick all render. The last is the visual top
  // and the only active one; the rest carry replaced=true. Dismissing the top
  // clears the whole stack, since the faded entries unmount invisibly.
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
    // DOM order is stack order, newest last. matchMedia=false means only the
    // mobile branch renders, so one stub per stack entry.
    const stubs = screen.getAllByTestId('match-moment-stub');
    expect(stubs.length).toBe(2);
    // `a` is underneath: not big, replaced.
    expect(stubs[0].getAttribute('data-match-id')).toBe('a');
    expect(stubs[0].getAttribute('data-is-big')).toBe('false');
    expect(stubs[0].getAttribute('data-replaced')).toBe('true');
    // `b` is on top: big (session's first celebration), not replaced.
    expect(stubs[1].getAttribute('data-match-id')).toBe('b');
    expect(stubs[1].getAttribute('data-is-big')).toBe('true');
    expect(stubs[1].getAttribute('data-replaced')).toBe('false');
    // The top's dismiss fires dismissPending, clearing the whole stack.
    const bDismiss = stubs[1].querySelector('[data-testid="match-dismiss"]') as HTMLButtonElement;
    fireEvent.click(bDismiss);
    expect(screen.queryAllByTestId('match-moment-stub').length).toBe(0);
  });
});

describe('RoomScreen: Share button (clipboard + fallbacks)', () => {
  beforeEach(() => {
    withState({ room: { name: 'movie-night', users: [], matches: [], media: [] } });
    // Known base for the share URL.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        href: 'https://reely.example.com/?stale=keep',
        search: '?stale=keep',
      },
    });
  });

  // ShareButton's label alternates between "Share" and "Copied!", so match
  // either.
  const clickShareButton = () => {
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
    // Both labels stay in the DOM to keep the button width stable, so
    // textContent always holds both; the active one is aria-hidden="false".
    const share = screen.getAllByRole('button').find((b) => /share|copied/i.test(b.textContent ?? ''));
    const visibleLabel = share?.querySelector<HTMLElement>('span[aria-hidden="false"]');
    expect(visibleLabel?.textContent).toBe('Copied!');
  });

  const visibleShareLabel = () => {
    const share = screen.getAllByRole('button').find((b) => /share|copied/i.test(b.textContent ?? ''));
    return share?.querySelector<HTMLElement>('span[aria-hidden="false"]')?.textContent;
  };

  // An uncancelled timer per click meant the first one fired mid-way through
  // the second copy's window and pulled the confirmation the user had just
  // triggered back to "Share" after a fraction of a second.
  it('restarts the "Copied!" window on a second copy instead of inheriting the first timer', async () => {
    vi.useFakeTimers();
    // execCommand path: synchronous, so nothing has to resolve under fake timers.
    vi.stubGlobal('navigator', {});
    document.execCommand = vi.fn().mockReturnValue(true);
    render(<RoomScreen />);

    clickShareButton();
    await act(async () => {});
    expect(visibleShareLabel()).toBe('Copied!');

    act(() => { vi.advanceTimersByTime(1400); });
    clickShareButton();
    await act(async () => {});

    // 1400ms past the SECOND click: the first click's deadline is long gone,
    // and only the restarted timer governs.
    act(() => { vi.advanceTimersByTime(1400); });
    expect(visibleShareLabel()).toBe('Copied!');

    act(() => { vi.advanceTimersByTime(200); });
    expect(visibleShareLabel()).toBe('Share');
  });

  // prompt() is the last resort, so the user can still copy the link by hand.
  it('falls back to window.prompt when neither clipboard.writeText nor execCommand succeeds', async () => {
    vi.stubGlobal('navigator', {});
    // jsdom's default, pinned explicitly.
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
