// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ToastList, type Toast } from '../../../../web/app/src/components/atoms/Toast';

// ToastList renders a list of toasts and auto-removes each one after its
// `showTimeMs` elapses. Behavioral surface worth pinning:
//   - The setTimeout per toast (only when showTimeMs is set).
//   - Audit 10 #135: when a toast is removed externally (e.g. by click),
//     the pending timer must be cleared so it can't fire later as a no-op
//     against an already-removed toast (slow leak across long sessions).
//   - Audit 13 #310: the timers Map is constructed lazily on first read
//     (the prior `useRef(new Map(...))` constructed one fresh per render
//     even though React only keeps the first; cheap individually but a
//     per-render allocation across the component lifetime).
//   - Unmount clears every pending timer.
//   - A re-render with the SAME toast does NOT restart that toast's timer.

const t = (over: Partial<Toast> = {}): Toast => ({
  id: 't1',
  message: 'hello',
  showTimeMs: 1000,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ToastList', () => {
  it('renders each toast\'s message inside an <li>', () => {
    const { container } = render(
      <ToastList toasts={[t({ id: 'a', message: 'first' }), t({ id: 'b', message: 'second' })]} removeToast={vi.fn()} />,
    );
    const items = container.querySelectorAll('li');
    expect(items.length).toBe(2);
    expect(items[0]?.textContent).toBe('first');
    expect(items[1]?.textContent).toBe('second');
  });

  it('renders an empty list when toasts is undefined', () => {
    const { container } = render(<ToastList removeToast={vi.fn()} />);
    expect(container.querySelectorAll('li').length).toBe(0);
  });

  it('applies the appearance class (Success / Failure / default)', () => {
    const { container } = render(
      <ToastList
        toasts={[
          t({ id: 'ok', message: 'ok', appearance: 'Success' }),
          t({ id: 'no', message: 'no', appearance: 'Failure' }),
          t({ id: 'plain', message: 'plain' }),
        ]}
        removeToast={vi.fn()}
      />,
    );
    const items = container.querySelectorAll('li');
    expect(items[0]?.getAttribute('class')).toMatch(/toastSuccess/);
    expect(items[1]?.getAttribute('class')).toMatch(/toastFailure/);
    // Default (no appearance) -> styles[`toast`] -> 'toast' class.
    expect(items[2]?.getAttribute('class')).toMatch(/toast/);
  });

  it('fires removeToast after the showTimeMs elapses', () => {
    const removeToast = vi.fn();
    const toast = t({ id: 'a', showTimeMs: 500 });
    render(<ToastList toasts={[toast]} removeToast={removeToast} />);
    expect(removeToast).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(removeToast).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(removeToast).toHaveBeenCalledTimes(1);
    expect(removeToast).toHaveBeenCalledWith(toast);
  });

  it('does NOT auto-remove a toast that has no showTimeMs', () => {
    const removeToast = vi.fn();
    render(
      <ToastList toasts={[t({ id: 'sticky', showTimeMs: undefined })]} removeToast={removeToast} />,
    );
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(removeToast).not.toHaveBeenCalled();
  });

  // Audit 10 #135: a toast removed externally (e.g. by click) leaves a
  // pending setTimeout behind. The cleanup loop in the effect must clear
  // that timer and drop its entry from the Map -- otherwise the entry
  // would leak across the component lifetime in long-running sessions.
  it('cancels the pending timer when a toast is removed externally before its timeout', () => {
    const removeToast = vi.fn();
    const initial = [t({ id: 'a', message: 'first', showTimeMs: 1000 })];
    const { rerender } = render(<ToastList toasts={initial} removeToast={removeToast} />);
    // Remove the toast externally well before the 1s timeout would fire.
    act(() => {
      rerender(<ToastList toasts={[]} removeToast={removeToast} />);
    });
    // Past the original timeout: removeToast must NOT have been called by
    // the cancelled timer (the array was already empty by then).
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(removeToast).not.toHaveBeenCalled();
  });

  // The `if (getTimers().has(toast.id)) return;` short-circuit prevents
  // restarting a timer for a toast that already has one. Without it,
  // every render would spawn a fresh setTimeout for toasts[0] -- the
  // pre-Map-tracking bug behavior. Verified by re-rendering the same
  // toast and asserting removeToast fires EXACTLY ONCE at the original
  // timeout, not multiple times.
  it('does not restart timers when the same toast re-renders', () => {
    const removeToast = vi.fn();
    const toast = t({ id: 'a', showTimeMs: 1000 });
    const { rerender } = render(<ToastList toasts={[toast]} removeToast={removeToast} />);
    // Advance partway, re-render the same toast, advance the rest.
    act(() => {
      vi.advanceTimersByTime(600);
    });
    act(() => {
      rerender(<ToastList toasts={[toast]} removeToast={removeToast} />);
    });
    act(() => {
      vi.advanceTimersByTime(401); // total = 1001 from initial render
    });
    expect(removeToast).toHaveBeenCalledTimes(1);
  });

  // Mount/unmount cleanup effect: all pending timers must be cleared on
  // unmount. Without this, a setTimeout scheduled during the component's
  // life would fire after unmount and call removeToast on a parent that
  // no longer renders.
  it('clears every pending timer on unmount', () => {
    const removeToast = vi.fn();
    const { unmount } = render(
      <ToastList
        toasts={[
          t({ id: 'a', showTimeMs: 500 }),
          t({ id: 'b', showTimeMs: 1000 }),
        ]}
        removeToast={removeToast}
      />,
    );
    unmount();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(removeToast).not.toHaveBeenCalled();
  });

  // Multiple toasts each get their own timer.
  it('schedules an independent timer per toast', () => {
    const removeToast = vi.fn();
    const a = t({ id: 'a', message: 'first', showTimeMs: 300 });
    const b = t({ id: 'b', message: 'second', showTimeMs: 700 });
    render(<ToastList toasts={[a, b]} removeToast={removeToast} />);
    act(() => {
      vi.advanceTimersByTime(301);
    });
    expect(removeToast).toHaveBeenCalledTimes(1);
    expect(removeToast).toHaveBeenLastCalledWith(a);
    act(() => {
      vi.advanceTimersByTime(400); // total 701
    });
    expect(removeToast).toHaveBeenCalledTimes(2);
    expect(removeToast).toHaveBeenLastCalledWith(b);
  });
});
