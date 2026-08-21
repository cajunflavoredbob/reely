// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ToastList, type Toast } from '../../../../web/app/src/components/atoms/Toast';

// ToastList auto-removes each toast after its `showTimeMs`. Pinned here: one
// timer per toast and only when showTimeMs is set; external removal and unmount
// clear pending timers; a re-render does not restart a live timer.

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
    // No appearance -> styles['toast'].
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

  // A toast removed externally (e.g. by click) leaves a pending setTimeout; the
  // effect cleanup must clear it and drop the Map entry, or it leaks for the
  // component's life.
  it('cancels the pending timer when a toast is removed externally before its timeout', () => {
    const removeToast = vi.fn();
    const initial = [t({ id: 'a', message: 'first', showTimeMs: 1000 })];
    const { rerender } = render(<ToastList toasts={initial} removeToast={removeToast} />);
    act(() => {
      rerender(<ToastList toasts={[]} removeToast={removeToast} />);
    });
    // Past the original timeout: the cancelled timer must not fire.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(removeToast).not.toHaveBeenCalled();
  });

  // Without the `if (getTimers().has(toast.id)) return;` short-circuit, every
  // render spawns a fresh setTimeout for the same toast.
  it('does not restart timers when the same toast re-renders', () => {
    const removeToast = vi.fn();
    const toast = t({ id: 'a', showTimeMs: 1000 });
    const { rerender } = render(<ToastList toasts={[toast]} removeToast={removeToast} />);
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

  // A timer surviving unmount calls removeToast on a parent that no longer
  // renders.
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
