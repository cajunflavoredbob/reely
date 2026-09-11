// @vitest-environment jsdom
//
// biome-ignore-all lint/suspicious/noExplicitAny: fixtures are partial; these exercise behavior, not type narrowing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// Targets FilterPanel's external contract only: close, apply, submit-button
// label and enabled state, loading copy, field count, isDrawer class, and the
// re-open re-sync. FilterRow / FieldPicker / SearchControl internals have
// their own tests.

const { useStoreMock, useDispatchMock } = vi.hoisted(() => ({
  useStoreMock: vi.fn(),
  useDispatchMock: vi.fn(),
}));

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  useDispatch: useDispatchMock,
  useSelector: vi.fn(),
  createStore: vi.fn(),
}));

import { FilterPanel } from '../../../../web/app/src/components/organisms/FilterPanel';
import { FILTER_VALUES_UNAVAILABLE } from '../../../../web/app/src/store/reducer';
import type { Filter, Filters } from '../../../../types/reely';

// Minimal catalog: one integer field, one string field, one operator each.
const baseFilters = (): Filters => ({
  filters: [
    { key: 'year', title: 'Year', type: 'integer' },
    { key: 'genre', title: 'Genre', type: 'string' },
  ],
  filterTypes: {
    integer: [{ key: '=', title: 'is' }],
    string: [{ key: '=', title: 'is' }],
    boolean: [],
  } as any,
}) as any;

let dispatch: ReturnType<typeof vi.fn>;

const withState = (slice: { createRoom?: any; room?: any } = {}) => {
  useStoreMock.mockReturnValue([
    {
      createRoom: undefined,
      room: undefined,
      ...slice,
    },
    dispatch,
  ]);
};

beforeEach(() => {
  dispatch = vi.fn();
  useStoreMock.mockReset();
  useDispatchMock.mockReset().mockReturnValue(dispatch);
  withState();
});

afterEach(() => {
  cleanup();
});

describe('FilterPanel: loading state', () => {
  // Tr renders the raw key when no translations are loaded.
  it('shows the FILTERS_LOADING Tr key when no availableFilters yet', () => {
    withState({ createRoom: { availableFilters: undefined } });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByText('FILTERS_LOADING')).toBeDefined();
  });

  it('omits the field-count "N fields available" line while loading', () => {
    withState({ createRoom: { availableFilters: undefined } });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.queryByText(/fields available/)).toBeNull();
  });
});

describe('FilterPanel: header chrome (filter catalog loaded)', () => {
  it('renders the "Filter the room" + "Build a shortlist" headings', () => {
    withState({ createRoom: { availableFilters: baseFilters() } });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByText('Filter the room')).toBeDefined();
    // An accent span splits "shortlist" off, so match on the heading role.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Build a.*shortlist/);
  });

  it('shows the "{count} fields available" once availableFilters arrives', () => {
    withState({ createRoom: { availableFilters: baseFilters() } });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByText('2 fields available')).toBeDefined();
  });

  it('renders the close button (aria-label "Close")', () => {
    withState({ createRoom: { availableFilters: baseFilters() } });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined();
  });

  it('clicking the close button fires onClose', () => {
    withState({ createRoom: { availableFilters: baseFilters() } });
    const onClose = vi.fn();
    render(<FilterPanel onClose={onClose} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('FilterPanel: empty state', () => {
  it('shows the "No filters yet" copy when draft is empty (no activeFilters seed)', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [] },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByText(/No filters yet/i)).toBeDefined();
  });
});

describe('FilterPanel: Apply button (default state)', () => {
  it('labels the submit button "Apply filters" when the draft is empty', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [] },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Apply filters' })).toBeDefined();
  });

  // Enabled only with an applicable filter, or in Clear mode below.
  it('disables the Apply button when the draft has no applicable filters', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [] },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(
      (screen.getByRole('button', { name: 'Apply filters' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows the "ADD AT LEAST ONE FILTER" footer hint when draft is empty', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [] },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByText(/ADD AT LEAST ONE FILTER/)).toBeDefined();
  });
});

describe('FilterPanel: Apply with a populated draft (seeded from activeFilters)', () => {
  // The draft clones room.activeFilters, so edits start from the applied set.
  const filterFixture = (): Filter[] => [
    { key: 'year', operator: '=', value: ['2024'] } as Filter,
  ];

  it('enables the Apply button when activeFilters seed has an applicable filter', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: filterFixture() },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(
      (screen.getByRole('button', { name: 'Apply filters' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('clicking Apply fires onApply with the applicable draft filters AND onClose', () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: filterFixture() },
    });
    render(<FilterPanel onClose={onClose} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toEqual([
      { key: 'year', operator: '=', value: ['2024'] },
    ]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the "APPLIES FOR EVERYONE" hint when the draft has applicable filters', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: filterFixture() },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByText(/APPLIES FOR EVERYONE/)).toBeDefined();
  });
});

describe('FilterPanel: Clear mode (room has filters, draft is empty)', () => {
  // Removing every row from a panel that opened with applied filters flips the
  // button to "Clear filters" and enables it, so the empty submission clears
  // the server-side set. Without this branch the disabled-empty-draft gate
  // makes applied filters unremovable.
  it('labels the submit button "Clear filters" when room has activeFilters but draft is empty', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      // value: [] is inapplicable, so the draft filters down to [] while
      // activeFilters stays non-empty: hasActiveFilters -> isClearing.
      room: { activeFilters: [{ key: 'year', operator: '=', value: [] }] },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeDefined();
  });

  it('enables the Clear button (canSubmit via isClearing branch)', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [{ key: 'year', operator: '=', value: [] }] },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(
      (screen.getByRole('button', { name: 'Clear filters' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('shows the "CLEARS ALL FILTERS FOR EVERYONE" footer hint in Clear mode', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [{ key: 'year', operator: '=', value: [] }] },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByText(/CLEARS ALL FILTERS/)).toBeDefined();
  });

  it('clicking Clear fires onApply with an empty array AND onClose', () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [{ key: 'year', operator: '=', value: [] }] },
    });
    render(<FilterPanel onClose={onClose} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onApply).toHaveBeenCalledWith([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('FilterPanel: a newly added row with no value yet', () => {
  // addFilter seeds a non-boolean row with an empty value, so Apply is
  // disabled. The hint has to say a value is missing rather than fall through
  // to the copy describing who an Apply would reach.
  const addYearRow = () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [] },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Add filter/ }));
    fireEvent.click(screen.getByRole('button', { name: /Year/ }));
  };

  it('shows the "PICK A VALUE" footer hint, not the scope copy', () => {
    addYearRow();
    expect(screen.getByText(/PICK A VALUE/)).toBeDefined();
    expect(screen.queryByText(/APPLIES FOR EVERYONE/)).toBeNull();
  });

  it('keeps Apply disabled until the row has a value', () => {
    addYearRow();
    expect(
      (screen.getByRole('button', { name: 'Apply filters' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('FilterPanel: a draft row whose key is missing from the catalog', () => {
  // room.activeFilters and the filter catalog are two independent server
  // payloads and can disagree: Plex drops the synthetic `library` filter once
  // the server is down to one movie library, while the persisted room file
  // still carries it. The row renders as nothing, so counting it toward
  // canApply left the room locked to a filter nobody could see or remove.
  const withOrphanedRow = () =>
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [{ key: 'library', operator: '=', value: ['3'] }] },
    });

  it('still shows the "No filters yet" copy rather than a blank body', () => {
    withOrphanedRow();
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByText(/No filters yet/i)).toBeDefined();
  });

  it('offers Clear mode instead of an enabled Apply', () => {
    withOrphanedRow();
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Clear filters' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('does not resubmit the unknown row on Apply', () => {
    const onApply = vi.fn();
    withOrphanedRow();
    render(<FilterPanel onClose={vi.fn()} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onApply).toHaveBeenCalledWith([]);
  });

  // While the catalog is in flight every key looks unknown, so the fallback
  // has to keep the seeded draft applicable rather than flip to Clear mode.
  it('does not flip to Clear mode while the catalog is still loading', () => {
    withState({
      createRoom: { availableFilters: undefined },
      room: { activeFilters: [{ key: 'year', operator: '=', value: ['2024'] }] },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Apply filters' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });
});

describe('FilterPanel: a row whose values failed to load', () => {
  // Three empty-ish states share one slot: no entry (request in flight), a
  // plain [] (the field has no enumerable values) and the failure marker. The
  // marker has to reach the user as an error with a way out, or the row spins
  // on "Loading values…" until the panel is reopened, which used to re-fire
  // the request and toast again for every row.
  const withFailedGenre = () =>
    withState({
      createRoom: {
        availableFilters: baseFilters(),
        filterValues: { genre: FILTER_VALUES_UNAVAILABLE },
      },
      room: { activeFilters: [{ key: 'genre', operator: '=', value: [] }] },
    });

  const expandGenre = () => {
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Genre/ }));
  };

  it('shows the failure and a Retry instead of spinning on "Loading values"', () => {
    withFailedGenre();
    expandGenre();
    expect(screen.getByText(/Couldn't load values/)).toBeDefined();
    expect(screen.queryByText(/Loading values/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  // The free-text box can't produce the tag ids an enumerated field matches
  // on, so a failure must never be mistaken for "this field has no values".
  it('does not fall back to the free-text control', () => {
    withFailedGenre();
    expandGenre();
    expect(screen.queryByPlaceholderText(/Add genre/i)).toBeNull();
  });

  it('a genuinely empty value list still gets the free-text control', () => {
    withState({
      createRoom: {
        availableFilters: baseFilters(),
        filterValues: { genre: [] },
      },
      room: { activeFilters: [{ key: 'genre', operator: '=', value: [] }] },
    });
    expandGenre();
    expect(screen.getByPlaceholderText(/Add genre/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  // The toast storm: every guard used to test for a missing entry, so a failed
  // key was re-requested on mount and on every expand and panel open.
  it('does not re-request a failed key on its own', () => {
    withFailedGenre();
    expandGenre();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('re-requests once when the user clicks Retry', () => {
    withFailedGenre();
    expandGenre();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'requestFilterValues',
      payload: { key: 'genre' },
    });
  });

  it('still requests values for a key nothing is known about', () => {
    withState({
      createRoom: { availableFilters: baseFilters(), filterValues: {} },
      room: { activeFilters: [{ key: 'genre', operator: '=', value: [] }] },
    });
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'requestFilterValues',
      payload: { key: 'genre' },
    });
  });
});

// requestFiltersError parks `{ filters: [], filterTypes: {} }` on any getFilters
// failure, so an empty catalog means "we couldn't ask", not "this room has no
// fields". Judging keys against it makes every draft row unknown, and the
// footer of a filtered room turns into an enabled "Clear filters": one click
// from wiping the whole room's filters, in a panel claiming there are none.
describe('FilterPanel: catalog fetch failed (empty filter set)', () => {
  const withEmptyCatalog = () =>
    withState({
      createRoom: { availableFilters: { filters: [], filterTypes: {} } as any },
      room: { activeFilters: [{ key: 'year', operator: '=', value: ['2024'] }] },
    });

  it('does not offer Clear mode for a room that has filters', () => {
    withEmptyCatalog();
    render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    expect(screen.queryByText(/CLEARS ALL FILTERS/)).toBeNull();
  });

  it('keeps the button as a harmless re-Apply of what is already active', () => {
    const onApply = vi.fn();
    withEmptyCatalog();
    render(<FilterPanel onClose={vi.fn()} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(onApply).toHaveBeenCalledWith([
      { key: 'year', operator: '=', value: ['2024'] },
    ]);
  });
});

describe('FilterPanel: isDrawer layout switch', () => {
  it('uses the drawer-content class when isDrawer is true', () => {
    withState({ createRoom: { availableFilters: baseFilters() } });
    const { container } = render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} isDrawer />);
    expect(container.firstChild).toHaveProperty('className');
    expect((container.firstChild as HTMLElement).getAttribute('class')).toMatch(/drawerContent/);
  });

  it('uses the overlay class by default (isDrawer omitted)', () => {
    withState({ createRoom: { availableFilters: baseFilters() } });
    const { container } = render(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} />);
    expect((container.firstChild as HTMLElement).getAttribute('class')).toMatch(/overlay/);
  });
});

describe('FilterPanel: re-open re-sync (isOpen toggle false -> true)', () => {
  // In-progress edits survive server-side activeFilters changes while open;
  // only a closed -> open transition re-syncs, so the panel never reopens
  // with edits left from last time.
  it('re-syncs draft from room.activeFilters when isOpen toggles false -> true', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [{ key: 'year', operator: '=', value: ['2020'] }] },
    });
    const { rerender } = render(
      <FilterPanel onClose={vi.fn()} onApply={vi.fn()} isOpen={false} />,
    );
    // Seeded from an applicable activeFilters, so Apply starts enabled.
    expect((screen.getByRole('button', { name: 'Apply filters' }) as HTMLButtonElement).disabled).toBe(false);
    // activeFilters changes server-side while the panel is closed.
    act(() => {
      withState({
        createRoom: { availableFilters: baseFilters() },
        room: { activeFilters: [] },
      });
      rerender(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} isOpen={false} />);
    });
    // Opening re-syncs the draft from the now-empty activeFilters.
    act(() => {
      rerender(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} isOpen={true} />);
    });
    expect((screen.getByRole('button', { name: 'Apply filters' }) as HTMLButtonElement).disabled).toBe(true);
  });

  // The other half of the invariant, and the half the walk above cannot see:
  // held open, another user's filterChangeApplied must not wipe the rows you
  // are mid-edit on. Desktop keeps the panel mounted, so this is the common
  // case, not the corner one.
  it('does NOT re-sync the draft while the panel stays open', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [{ key: 'year', operator: '=', value: ['2020'] }] },
    });
    const { rerender } = render(
      <FilterPanel onClose={vi.fn()} onApply={vi.fn()} isOpen={true} />,
    );
    expect(screen.getByText('Year')).toBeDefined();
    // Another member applies a different set while this panel is open.
    act(() => {
      withState({
        createRoom: { availableFilters: baseFilters() },
        room: { activeFilters: [{ key: 'genre', operator: '=', value: ['Drama'] }] },
      });
      rerender(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} isOpen={true} />);
    });
    expect(screen.getByText('Year')).toBeDefined();
    expect(screen.queryByText('Genre')).toBeNull();
  });
});
