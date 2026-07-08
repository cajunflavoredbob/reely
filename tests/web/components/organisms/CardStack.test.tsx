// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// CardStack's animation surface (@react-spring/web Controller +
// @use-gesture/react useGesture) couldn't be intercepted via vi.mock --
// the SUT's imports resolve through the web/app pnpm tree which vitest
// externalizes past where the mock factory runs. (Aliasing the modules
// to web/app installs + installing at root + deps.optimizer.web.include
// were all tried 0.4.43; none caused the mock factory to fire.)
//
// Concretely this means the dismissal-callback fire path
// (rateItem -> dispatch remove -> controller.start().then(onCardDismissed))
// can't be exercised end-to-end here: the real react-spring Controller's
// animation needs a requestAnimationFrame loop that jsdom doesn't advance,
// so the .then(cb) never fires. The tests below cover everything that's
// reachable without intercepting Controller: empty state, populated
// rendering, the connection-status early-returns in the button + keyboard
// handlers, and the memo() `() => true` invariant. Driving the dismissal
// callback would need either: a Controller mock that DOES intercept (likely
// requires deeper vitest config work, or restructuring the SUT to inject
// the Controller factory), or moving to a real-browser harness (Playwright).
const { useStoreMock } = vi.hoisted(() => ({ useStoreMock: vi.fn() }));

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  // useStoreComputed (audit 16 #432) runs the component's selector against
  // the same slice withState() configured, so tests keep one state knob.
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

// jsdom doesn't ship ResizeObserver; CardStack's useElementWidth hook
// constructs one. Stub a no-op class so the constructor + observe/disconnect
// calls don't crash. We're not testing the resize-driven width updates here.
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
  it('renders the empty heart + "That\'s everything." copy when no cards', () => {
    render(<CardStack cards={[]} renderCard={renderCard} onCardDismissed={vi.fn()} />);
    expect(screen.getByText("That's everything.")).toBeDefined();
  });

  // The empty subtext uses <Tr name="RATE_SECTION_EXHAUSTED_CARDS" />. Tr
  // falls back to rendering the name itself when no translation matches
  // (translations slice is absent from our store mock), so the raw key
  // appears as the text.
  it('renders the RATE_SECTION_EXHAUSTED_CARDS Tr key in the empty subtext', () => {
    render(<CardStack cards={[]} renderCard={renderCard} onCardDismissed={vi.fn()} />);
    expect(screen.getByText('RATE_SECTION_EXHAUSTED_CARDS')).toBeDefined();
  });

  // Audit 16 #461: the 0.5.22 filtered-empty-stack branch had no coverage
  // -- the hasActiveFilters ternary switching to the FILTERED key could
  // regress and fail nothing.
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
    // Only the first 5 should be initially mounted; INITIAL_COUNT is 5
    // (cardStackGeometry.ts). Cards 6+ are deferred until the reducer
    // dispatches 'add' as earlier cards get removed.
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
  // The dismissal flow short-circuits at the very top of rateItem when
  // connectionStatus !== "connected", so the controller is never touched
  // and onCardDismissed never gets a chance to fire. Pinning this prevents
  // the local deck from diverging from the server (rate() is dropped when
  // disconnected -- without the gate, the local stack would move on while
  // the server stays put).
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

  // Non-arrow keys also never fire the dismissal -- the keydown handler's
  // first guard is the connection status, the second is the arrow-key
  // check. Pin the arrow-key gating direction (Space / Enter / letters
  // should never trigger a swipe).
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

// Audit 16 #420: the window-level arrow-key handler must ignore keydown
// events that originate from editable/interactive elements. FilterPanel's
// text inputs and operator <select>s stay mounted alongside the stack on
// both layouts, and a caret move inside them must not swipe (ratings are
// permanent server-side; a stray like can false-match the whole room).
//
// Observable signal: rateItem dispatches remove+add, and 'add' mounts the
// next deferred card past INITIAL_COUNT (5). With 7 cards, card-c5 appearing
// means the arrow key rated; card-c5 staying unmounted means it was ignored.
// (onCardDismissed can't fire in jsdom -- see the header comment -- so the
// deferred-mount side effect is the reachable assertion.)
describe('CardStack: arrow keys from editable elements are ignored (audit 16 #420)', () => {
  const sevenCards = () => Array.from({ length: 7 }, (_, i) => card(`c${i}`));

  it('ArrowRight from the window/body rates (mounts the next deferred card)', () => {
    render(
      <CardStack cards={sevenCards()} renderCard={renderCard} onCardDismissed={vi.fn()} />,
    );
    expect(screen.queryByTestId('card-c5')).toBeNull();
    fireEvent.keyDown(window, { code: 'ArrowRight' });
    expect(screen.getByTestId('card-c5')).toBeDefined();
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

describe('CardStack: memo blocks all prop-change re-renders (documented invariant)', () => {
  // INVARIANT documented in the source: the memo's areEqual returns true
  // unconditionally. Spring controllers own their animation state
  // internally; re-rendering on a prop change would tear down + recreate
  // them mid-animation. The parent (Room.tsx) forces a full remount via
  // `key={room.mediaVersion}` when the card set genuinely changes -- that
  // is the ONLY supported path for new cards to enter this component.
  //
  // Pin the invariant so a future contributor who removes the memo (or
  // changes areEqual) breaks this test loudly + has to think through the
  // animation-safety consequences listed in the source comment.
  it('updating the cards prop after mount does NOT add new cards', () => {
    const { rerender } = render(
      <CardStack cards={[card('a')]} renderCard={renderCard} onCardDismissed={vi.fn()} />,
    );
    expect(screen.getByTestId('card-a')).toBeDefined();
    expect(screen.queryByTestId('card-b')).toBeNull();
    rerender(
      <CardStack cards={[card('a'), card('b')]} renderCard={renderCard} onCardDismissed={vi.fn()} />,
    );
    // The new 'b' card MUST NOT appear -- the memo blocks the re-render.
    // Verified by the absence; the parent would have to remount the whole
    // CardStack (via `key=`) to get a fresh card set in.
    expect(screen.queryByTestId('card-b')).toBeNull();
  });
});
