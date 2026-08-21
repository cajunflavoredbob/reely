// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, act } from '@testing-library/react';
import { create } from 'zustand';

// Mocks only `useZustandStore`, swapping in a real Zustand store under test
// control: pick-by-keys and useShallow run end to end without the WS client
// and listeners createStore() would set up. vi.hoisted lifts the holder cell
// so vi.mock's factory can read it at module-bind time.
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

// Minimal Store-shaped fixture; only a handful of keys are touched.
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

  // useShallow holds the subset identity when only unpicked keys change; that
  // is what stops needless consumer re-renders.
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

  // A picked key must yield a new reference so downstream useMemo re-fires.
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
