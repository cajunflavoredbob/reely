// @vitest-environment jsdom
//
// biome-ignore-all lint/suspicious/noExplicitAny: Filter / Filters fixture shapes are partial; full discriminated unions aren't the point in the tests here -- we exercise the external behavior, not the type narrowing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

// FilterPanel has the deferred #321 split tension (FilterRow / FieldPicker
// / SearchControl) -- writing tests against the current internal shape
// risks throwaway when the split lands. These tests deliberately target
// the EXTERNAL contract surface that should survive any reasonable
// split:
//   - onClose called by the close button
//   - onApply called with the draft filters + onClose follow-on
//   - "Apply filters" vs "Clear filters" button label + enabled/disabled
//   - "FILTERS_LOADING" Tr while availableFilters is undefined
//   - empty-state copy
//   - field count in header when filters loaded
//   - isDrawer prop selects the drawer-content class
//   - re-open (isOpen toggles false -> true) re-syncs the draft from
//     room.activeFilters
//
// Internal row / picker / SearchControl behavior is NOT covered here --
// once #321 lands those will live in dedicated component tests.

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
import type { Filter, Filters } from '../../../../types/reely';

// Minimal Filters catalog: one int field "year" with one operator "=",
// one string field "genre". Enough to render row UI when a filter
// references either key.
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
  // Until `createRoom.availableFilters` arrives from the server, the
  // panel shows a loading line. The copy comes through <Tr
  // name="FILTERS_LOADING" />; Tr falls back to rendering the raw key
  // when no translations are loaded (verified in Tr's own test).
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
    // "Build a shortlist" is split across two spans (the accent wraps
    // "shortlist") so use a heading-role lookup.
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

  // Disabled until the draft has at least one applicable filter (or
  // the panel enters Clear mode -- see below).
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
  // Draft initial state clones room.activeFilters so re-opening the panel
  // shows the current applied set as the starting point for edits.
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
  // When the user removes every filter row in a panel that opened with
  // applied filters, the button flips to "Clear filters" and is enabled
  // -- submitting an empty set clears the server-side applied set.
  // Without this branch, applied filters could never be removed from
  // the UI (the disabled-empty-draft gate would block submission).
  //
  // Triggered via a draft of [] AND room.activeFilters non-empty -- the
  // panel starts seeded from activeFilters, but the user can remove the
  // rows. Simulate the post-removal state by passing draft seed [] +
  // activeFilters non-empty (the seed happens on mount; here we mount
  // with an empty seed + a non-empty activeFilters).
  it('labels the submit button "Clear filters" when room has activeFilters but draft is empty', () => {
    // To get this state at mount: room.activeFilters has filters that
    // are NOT applicable (i.e. don't match any field in the catalog),
    // so the draft.filter(isFilterApplicable) returns []. The simplest
    // proxy: room.activeFilters has entries with keys that aren't in
    // baseFilters' field set.
    //
    // Actually simpler still: build a fixture whose values are empty so
    // isFilterApplicable returns false, but the rows still exist.
    withState({
      createRoom: { availableFilters: baseFilters() },
      // value: [] -> not applicable -> draft.filter(...) = []
      // BUT room.activeFilters.length > 0 -> hasActiveFilters = true
      // -> isClearing = true
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
  // While the panel is open, the user's in-progress edits stay put even
  // if room.activeFilters changes server-side. On a CLOSED -> OPEN
  // transition the draft re-syncs from room.activeFilters so the panel
  // doesn't reopen with stale-from-last-open edits.
  it('re-syncs draft from room.activeFilters when isOpen toggles false -> true', () => {
    withState({
      createRoom: { availableFilters: baseFilters() },
      room: { activeFilters: [{ key: 'year', operator: '=', value: ['2020'] }] },
    });
    const { rerender } = render(
      <FilterPanel onClose={vi.fn()} onApply={vi.fn()} isOpen={false} />,
    );
    // Verify mount under closed state shows "Apply filters" (draft seeded
    // from activeFilters which is applicable -> Apply enabled).
    expect((screen.getByRole('button', { name: 'Apply filters' }) as HTMLButtonElement).disabled).toBe(false);
    // Server-side: room.activeFilters changes while panel is closed.
    act(() => {
      withState({
        createRoom: { availableFilters: baseFilters() },
        room: { activeFilters: [] },
      });
      rerender(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} isOpen={false} />);
    });
    // Toggle open: the effect re-syncs draft from room.activeFilters ([])
    // -> draft is empty -> Apply disabled.
    act(() => {
      rerender(<FilterPanel onClose={vi.fn()} onApply={vi.fn()} isOpen={true} />);
    });
    expect((screen.getByRole('button', { name: 'Apply filters' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
