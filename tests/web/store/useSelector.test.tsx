// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, act } from '@testing-library/react';
import { create } from 'zustand';

// useSelector is the typed Pick wrapper around the Zustand store +
// useShallow. To test it honestly, mock just the `useZustandStore`
// export from createStore to be a real Zustand store under our control.
// That way useSelector's pick-by-keys + useShallow behavior runs end to
// end against a real store -- without dragging in the WS client +
// listeners that createStore() would set up.
//
// vi.hoisted lifts a store-holder cell so vi.mock's factory can read it
// at module-bind time (the mock factory runs before any other code in
// this file).
const { storeHolder } = vi.hoisted(() => ({
  storeHolder: { current: undefined as undefined | unknown },
}));

vi.mock('../../../web/app/src/store/createStore', () => ({
  get useZustandStore() {
    return storeHolder.current;
  },
  createStore: vi.fn(),
}));

import { useSelector } from '../../../web/app/src/store/useSelector';

// Minimal Store-shaped fixture. The Store type has many keys; we only
// touch a handful, so cast each `as any` at the boundary.
// biome-ignore lint/suspicious/noExplicitAny: full Store union not the point here.
const makeStore = (initial: any) => create<any>(() => initial);

beforeEach(() => {
  const store = makeStore({
    route: 'login',
    user: { userName: 'alice' },
    connectionStatus: 'connected',
    toasts: [],
  });
  storeHolder.current = store;
});

afterEach(() => {
  cleanup();
  storeHolder.current = undefined;
});

describe('useSelector', () => {
  it('returns only the picked keys (and nothing else)', () => {
    // biome-ignore lint/suspicious/noExplicitAny: keys narrowed via the hook signature.
    const { result } = renderHook(() => useSelector(['route', 'user'] as any));
    expect(result.current).toEqual({ route: 'login', user: { userName: 'alice' } });
    // Other keys must not appear in the picked subset.
    expect(Object.keys(result.current).sort()).toEqual(['route', 'user']);
  });

  it('picks a single key', () => {
    // biome-ignore lint/suspicious/noExplicitAny: keys narrowed via the hook signature.
    const { result } = renderHook(() => useSelector(['connectionStatus'] as any));
    expect(result.current).toEqual({ connectionStatus: 'connected' });
  });

  it('updates the picked subset when the underlying store changes', () => {
    // biome-ignore lint/suspicious/noExplicitAny: keys narrowed via the hook signature.
    const { result } = renderHook(() => useSelector(['route'] as any));
    expect(result.current.route).toBe('login');
    act(() => {
      // biome-ignore lint/suspicious/noExplicitAny: cast through to setState for the test fixture store.
      (storeHolder.current as any).setState({ route: 'room' });
    });
    expect(result.current.route).toBe('room');
  });

  // useShallow keeps the picked subset reference-stable when none of its
  // picked keys changed. A change to an UNRELATED key (e.g. `toasts`)
  // must NOT change the picked-subset object identity for keys
  // ['route', 'user']. This is what stops needless re-renders in the
  // consumer.
  it('returns a reference-stable subset when only unpicked keys change (useShallow)', () => {
    // biome-ignore lint/suspicious/noExplicitAny: keys narrowed via the hook signature.
    const { result, rerender } = renderHook(() => useSelector(['route', 'user'] as any));
    const before = result.current;
    act(() => {
      // biome-ignore lint/suspicious/noExplicitAny: cast through to setState for the test fixture store.
      (storeHolder.current as any).setState({ toasts: [{ id: 'x', message: 'm' }] });
    });
    rerender();
    expect(result.current).toBe(before);
  });

  // Conversely, changing a PICKED key must yield a new subset reference
  // (so the consumer's downstream useMemo / equality checks re-fire).
  it('returns a new subset reference when a picked key changes', () => {
    // biome-ignore lint/suspicious/noExplicitAny: keys narrowed via the hook signature.
    const { result } = renderHook(() => useSelector(['route'] as any));
    const before = result.current;
    act(() => {
      // biome-ignore lint/suspicious/noExplicitAny: cast through to setState for the test fixture store.
      (storeHolder.current as any).setState({ route: 'room' });
    });
    expect(result.current).not.toBe(before);
  });
});
