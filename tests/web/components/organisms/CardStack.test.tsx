// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// vi.mock cannot intercept @react-spring/web's Controller or
// @use-gesture/react here: the SUT resolves them through the web/app pnpm
// tree, which vitest externalizes past where the mock factory runs. So the
// dismissal path (rateItem -> dispatch remove -> controller.start().then(
// onCardDismissed)) is unreachable by animation; the real Controller needs a
// rAF loop jsdom never advances, so a throw never runs to completion here.
// The one way in is unmounting mid-throw, which stops the controllers and
// resolves their promises; see the unmount test below. Watching a throw
// finish normally would need an injectable Controller factory or a
// real-browser harness. Everything else is covered below.
const { useStoreMock } = vi.hoisted(() => ({ useStoreMock: vi.fn() }));

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  // Runs the component's selector against the slice withState() configured,
  // so tests keep a single state knob.
  useStoreComputed: (selector: (s: Record<string, unknown>) => unknown) => {
    const [slice] = useStoreMock();
    return selector(slice);
  },
  useDispatch: vi.fn(),
  useSelector: vi.fn(),
  createStore: vi.fn(),
}));

import { CardStack } from '../../../../web/app/src/components/organisms/CardStack';
import type { Media } from '../../../../types/reely';

const card = (id: string): Media =>
  ({
    id,
    type: 'movie',
    title: `Title ${id}`,
    description: '',
    plexKey: `/library/metadata/${id}`,
    posterUrl: undefined,
    year: 2024,
    duration: 0,
    rating: 0,
    genres: [],
    // biome-ignore lint/suspicious/noExplicitAny: full Media shape isn't the point in these renders.
  }) as any;

const renderCard = (c: Media) => <div data-testid={`card-${c.id}`}>{c.title}</div>;

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (slice: any = {}) => {
  useStoreMock.mockReturnValue([{ connectionStatus: 'connected', ...slice }, vi.fn()]);
};

// jsdom has no ResizeObserver and useElementWidth constructs one. No-op stub;
// resize-driven width updates are not under test.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  useStoreMock.mockReset();
  withState();
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CardStack: empty state', () => {
  it('renders the empty heart when no cards', () => {
    const { container } = render(
      <CardStack cards={[]} renderCard={renderCard} onCardDismissed={vi.fn()} />,
    );
    expect(container.querySelector('[class*="emptyIcon"] svg')).not.toBeNull();
  });

  // Tr renders the raw key when no translation matches, and the store mock
  // carries no translations slice.
  it('renders the RATE_SECTION_EXHAUSTED_CARDS Tr key in the empty subtext', () => {
    render(<CardStack cards={[]} renderCard={renderCard} onCardDismissed={vi.fn()} />);
    expect(screen.getByText('RATE_SECTION_EXHAUSTED_CARDS')).toBeDefined();
  });

  // The empty state is the app's most-translated surface, so the copy has to
  // come from the bundle alone: a hardcoded English headline used to sit above
  // the Tr and stack two languages in one block.
  it('renders no untranslated copy alongside the Tr key', () => {
    render(<CardStack cards={[]} renderCard={renderCard} onCardDismissed={vi.fn()} />);
    expect(screen.queryByText("That's everything.")).toBeNull();
  });

  // Without this the hasActiveFilters ternary can regress and fail nothing.
  it('renders the FILTERED Tr key when the room has active filters', () => {
    withState({ room: { activeFilters: [{ key: 'genre', operator: '=', value: ['Action'] }] } });
    render(<CardStack cards={[]} renderCard={renderCard} onCardDismissed={vi.fn()} />);
    expect(screen.getByText('RATE_SECTION_EXHAUSTED_CARDS_FILTERED')).toBeDefined();
  });

  it('omits the Pass + Like buttons in empty state', () => {
    render(<CardStack cards={[]} renderCard={renderCard} onCardDismissed={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Pass' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Like' })).toBeNull();
  });
});

describe('CardStack: populated rendering', () => {
  it('renders Pass + Like buttons when cards are present', () => {
    render(<CardStack cards={[card('a')]} renderCard={renderCard} onCardDismissed={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Pass' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Like' })).toBeDefined();
  });

  it('renders renderCard output for each card up to INITIAL_COUNT (5)', () => {
    const cards = Array.from({ length: 7 }, (_, i) => card(`c${i}`));
    render(<CardStack cards={cards} renderCard={renderCard} onCardDismissed={vi.fn()} />);
    // INITIAL_COUNT is 5 (cardStackGeometry.ts); later cards mount only as the
    // reducer dispatches 'add'.
    expect(screen.getByTestId('card-c0')).toBeDefined();
    expect(screen.getByTestId('card-c4')).toBeDefined();
    expect(screen.queryByTestId('card-c5')).toBeNull();
    expect(screen.queryByTestId('card-c6')).toBeNull();
  });

  it('renders fewer than INITIAL_COUNT cards when the input is smaller', () => {
    render(
      <CardStack cards={[card('a'), card('b')]} renderCard={renderCard} onCardDismissed={vi.fn()} />,
    );
    expect(screen.getByTestId('card-a')).toBeDefined();
    expect(screen.getByTestId('card-b')).toBeDefined();
    expect(screen.queryByTestId('card-c')).toBeNull();
  });
});

describe('CardStack: connection-status gates (button + keyboard early-return)', () => {
  // rateItem short-circuits when connectionStatus is not "connected". Without
  // the gate the local deck advances while the dropped rate() leaves the
  // server behind.
  it('Pass button while disconnected does NOT fire onCardDismissed', () => {
    withState({ connectionStatus: 'disconnected' });
    const onCardDismissed = vi.fn();
    render(
      <CardStack cards={[card('a')]} renderCard={renderCard} onCardDismissed={onCardDismissed} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pass' }));
    expect(onCardDismissed).not.toHaveBeenCalled();
  });

  it('Like button while disconnected does NOT fire onCardDismissed', () => {
    withState({ connectionStatus: 'disconnected' });
    const onCardDismissed = vi.fn();
    render(
      <CardStack cards={[card('a')]} renderCard={renderCard} onCardDismissed={onCardDismissed} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Like' }));
    expect(onCardDismissed).not.toHaveBeenCalled();
  });

  it('arrow keys while disconnected do NOT fire onCardDismissed', () => {
    withState({ connectionStatus: 'disconnected' });
    const onCardDismissed = vi.fn();
    render(
      <CardStack cards={[card('a')]} renderCard={renderCard} onCardDismissed={onCardDismissed} />,
    );
    fireEvent.keyDown(window, { code: 'ArrowLeft' });
    fireEvent.keyDown(window, { code: 'ArrowRight' });
    expect(onCardDismissed).not.toHaveBeenCalled();
  });

  // The affordance has to match the gate: without disabled the buttons keep
  // hover, the press scale and cursor: pointer while doing nothing.
  it('disables the Pass + Like buttons while disconnected', () => {
    withState({ connectionStatus: 'disconnected' });
    render(<CardStack cards={[card('a')]} renderCard={renderCard} onCardDismissed={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Pass' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Like' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves the Pass + Like buttons enabled while connected', () => {
    render(<CardStack cards={[card('a')]} renderCard={renderCard} onCardDismissed={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Pass' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Like' }) as HTMLButtonElement).disabled).toBe(false);
  });

  // The keydown handler guards on connection first, arrow key second: Space,
  // Enter and letters must never swipe.
  it('non-arrow keys never fire onCardDismissed even when connected', () => {
    const onCardDismissed = vi.fn();
    render(
      <CardStack cards={[card('a')]} renderCard={renderCard} onCardDismissed={onCardDismissed} />,
    );
    fireEvent.keyDown(window, { code: 'Space' });
    fireEvent.keyDown(window, { code: 'Enter' });
    fireEvent.keyDown(window, { code: 'KeyA' });
    expect(onCardDismissed).not.toHaveBeenCalled();
  });
});

// The window-level arrow-key handler must ignore keydown from editable or
// interactive elements: FilterPanel's inputs and operator <select>s stay
// mounted beside the stack, and a caret move must not swipe. Ratings are
// permanent server-side and a stray like false-matches the whole room.
//
// Signal: rateItem dispatches remove+add, and 'add' mounts the next deferred
// card past INITIAL_COUNT. With 7 cards, card-c5 appearing means it rated.
// (onCardDismissed cannot fire in jsdom; see the header comment.)
describe('CardStack: arrow keys from editable elements are ignored', () => {
  const sevenCards = () => Array.from({ length: 7 }, (_, i) => card(`c${i}`));

  it('ArrowRight from the window/body rates (mounts the next deferred card)', () => {
    render(
      <CardStack cards={sevenCards()} renderCard={renderCard} onCardDismissed={vi.fn()} />,
    );
    expect(screen.queryByTestId('card-c5')).toBeNull();
    fireEvent.keyDown(window, { code: 'ArrowRight' });
    expect(screen.getByTestId('card-c5')).toBeDefined();
  });

  // OS auto-repeat, not a fresh press. Holding an arrow otherwise rates a
  // card per repeat tick, and those ratings are permanent server-side.
  it('a repeating ArrowRight (held key) does NOT rate', () => {
    render(
      <CardStack cards={sevenCards()} renderCard={renderCard} onCardDismissed={vi.fn()} />,
    );
    fireEvent.keyDown(window, { code: 'ArrowRight', repeat: true });
    fireEvent.keyDown(window, { code: 'ArrowLeft', repeat: true });
    expect(screen.queryByTestId('card-c5')).toBeNull();
  });

  it('ArrowLeft from a text input does NOT rate', () => {
    render(
      <>
        <input data-testid="filter-search" />
        <CardStack cards={sevenCards()} renderCard={renderCard} onCardDismissed={vi.fn()} />
      </>,
    );
    fireEvent.keyDown(screen.getByTestId('filter-search'), { code: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByTestId('filter-search'), { code: 'ArrowRight' });
    expect(screen.queryByTestId('card-c5')).toBeNull();
  });

  it('ArrowDown/ArrowLeft from a <select> does NOT rate', () => {
    render(
      <>
        <select data-testid="operator-select">
          <option value="=">is</option>
          <option value="!=">is not</option>
        </select>
        <CardStack cards={sevenCards()} renderCard={renderCard} onCardDismissed={vi.fn()} />
      </>,
    );
    fireEvent.keyDown(screen.getByTestId('operator-select'), { code: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByTestId('operator-select'), { code: 'ArrowRight' });
    expect(screen.queryByTestId('card-c5')).toBeNull();
  });

  it('ArrowLeft from a contenteditable element does NOT rate', () => {
    render(
      <>
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: bare fixture element. */}
        <div data-testid="editable" contentEditable="true" />
        <CardStack cards={sevenCards()} renderCard={renderCard} onCardDismissed={vi.fn()} />
      </>,
    );
    fireEvent.keyDown(screen.getByTestId('editable'), { code: 'ArrowLeft' });
    expect(screen.queryByTestId('card-c5')).toBeNull();
  });
});

// The one dismissal-path assertion jsdom can make without a rAF loop: the
// unmount cleanup stops every controller, and stopping resolves the pending
// throw promise, so the continuation runs there and then.
describe('CardStack: a swipe caught by an unmount still reports the rating', () => {
  it('fires onCardDismissed when the stack unmounts inside the throw', async () => {
    const onCardDismissed = vi.fn();
    const cards = Array.from({ length: 7 }, (_, i) => card(`c${i}`));
    const { unmount } = render(
      <CardStack cards={cards} renderCard={renderCard} onCardDismissed={onCardDismissed} />,
    );

    // Starts the 150ms throw on card-c0; jsdom never advances it to completion.
    fireEvent.keyDown(window, { code: 'ArrowRight' });
    expect(onCardDismissed).not.toHaveBeenCalled();

    // Room remounts the stack on any mediaVersion bump (a rejoin, or another
    // member's filter change), which can land mid-throw. The rating is the
    // only producer of the server `rate` frame, so it must not be dropped:
    // that media set may not contain the card again.
    unmount();
    // The stop() resolves the throw promise a tick or two later, so poll
    // rather than counting microtasks.
    await vi.waitFor(() => expect(onCardDismissed).toHaveBeenCalledTimes(1));

    expect(onCardDismissed.mock.calls[0]?.[0]?.id).toBe('c0');
    expect(onCardDismissed.mock.calls[0]?.[1]).toBe('right');
  });
});

describe('CardStack: memo blocks all prop-change re-renders (documented invariant)', () => {
  // areEqual returns true unconditionally: spring controllers own their
  // animation state, and re-rendering on a prop change tears them down
  // mid-animation. Room.tsx remounts via `key={room.mediaVersion}` when the
  // card set changes; that is the only supported path for new cards.
  it('updating the cards prop after mount does NOT add new cards', () => {
    const { rerender } = render(
      <CardStack cards={[card('a')]} renderCard={renderCard} onCardDismissed={vi.fn()} />,
    );
    expect(screen.getByTestId('card-a')).toBeDefined();
    expect(screen.queryByTestId('card-b')).toBeNull();
    rerender(
      <CardStack cards={[card('a'), card('b')]} renderCard={renderCard} onCardDismissed={vi.fn()} />,
    );
    // The memo blocks the re-render, so 'b' must not appear.
    expect(screen.queryByTestId('card-b')).toBeNull();
  });

  // The prop change on its own cannot catch a missing comparator: the rendered
  // deck comes from the reducer's mount-time lazy initializer either way. What
  // the memo actually pins is which `cards` array the reducer closure sees on
  // the next 'add', so rate a card and check where its replacement came from.
  it('a later add pulls the next card from the mount-time array, not the replacement prop', () => {
    const original = Array.from({ length: 7 }, (_, i) => card(`c${i}`));
    const replacement = Array.from({ length: 7 }, (_, i) => card(`d${i}`));
    const { rerender } = render(
      <CardStack cards={original} renderCard={renderCard} onCardDismissed={vi.fn()} />,
    );
    rerender(
      <CardStack cards={replacement} renderCard={renderCard} onCardDismissed={vi.fn()} />,
    );
    fireEvent.keyDown(window, { code: 'ArrowRight' });
    // Without the comparator the re-render would hand the reducer the new
    // array and 'add' would mount card-d5 instead.
    expect(screen.getByTestId('card-c5')).toBeDefined();
    expect(screen.queryByTestId('card-d5')).toBeNull();
  });
});
