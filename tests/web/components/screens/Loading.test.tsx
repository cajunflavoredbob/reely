// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Loading } from '../../../../web/app/src/components/screens/Loading';

// Full-viewport branded loader. Pure presentation: no props, no deps.

afterEach(() => {
  cleanup();
});

describe('Loading', () => {
  it('renders the "reely" wordmark', () => {
    render(<Loading />);
    expect(screen.getByText('reely')).toBeDefined();
  });

  // status announces without stealing focus, and the aria-label carries the
  // description because the wordmark is aria-hidden.
  it('exposes a status role with the "Loading reely" label', () => {
    const { container } = render(<Loading />);
    const root = container.firstChild as HTMLElement;
    expect(root.getAttribute('role')).toBe('status');
    expect(root.getAttribute('aria-label')).toBe('Loading reely');
  });

  it('marks the wordmark itself as aria-hidden (decorative -- the status role owns the label)', () => {
    const { container } = render(<Loading />);
    expect(container.querySelector('span')?.getAttribute('aria-hidden')).toBe('true');
  });
});
