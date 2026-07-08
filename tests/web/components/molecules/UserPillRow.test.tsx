// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UserPillRow } from '../../../../web/app/src/components/molecules/UserPillRow';
import type { UserProgress } from '../../../../types/reely';

// UserPillRow renders a clickable button containing up to maxVisible
// UserPills + an overflow "+N" badge for the rest. The audit-14 #333
// memoization (useMemo around the sort) is an internal optimization;
// the behavioral surface is the ordering + the overflow math + the
// onClick + the aria-label.

const u = (userName: string, progress = 0): UserProgress => ({
  user: { userName },
  progress,
});

afterEach(() => {
  cleanup();
});

describe('UserPillRow', () => {
  it('renders all users when count is at or below maxVisible (default 4)', () => {
    render(
      <UserPillRow
        users={[u('alice'), u('bob'), u('carol'), u('dave')]}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText('alice')).toBeDefined();
    expect(screen.getByText('bob')).toBeDefined();
    expect(screen.getByText('carol')).toBeDefined();
    expect(screen.getByText('dave')).toBeDefined();
  });

  it('shows "+N" overflow badge when users exceed maxVisible', () => {
    render(
      <UserPillRow
        users={[u('a'), u('b'), u('c'), u('d'), u('e'), u('f')]}
        onClick={vi.fn()}
      />,
    );
    // Default maxVisible = 4, so 6 users -> 2 overflow.
    expect(screen.getByText('+2')).toBeDefined();
  });

  it('does NOT render an overflow badge when count equals maxVisible', () => {
    const { container } = render(
      <UserPillRow
        users={[u('a'), u('b'), u('c'), u('d')]}
        onClick={vi.fn()}
      />,
    );
    expect(container.textContent).not.toContain('+');
  });

  // Pin: the current user's pill is always inline (even in a crowded room
  // where it might otherwise have landed in overflow). Other users keep
  // server order.
  it('pins the current user to the front of the visible pills', () => {
    const { container } = render(
      <UserPillRow
        users={[u('alice'), u('bob'), u('carol'), u('dave'), u('me')]}
        myUserName="me"
        maxVisible={3}
        onClick={vi.fn()}
      />,
    );
    const pillSpans = container.querySelectorAll('button > span[title]');
    // Expect "me" first, then the first two non-me users in server order.
    const visibleNames = Array.from(pillSpans).map((s) => s.getAttribute('title'));
    expect(visibleNames).toEqual(['me', 'alice', 'bob']);
  });

  it('keeps server order among non-me users', () => {
    const { container } = render(
      <UserPillRow
        users={[u('alice'), u('bob'), u('carol')]}
        myUserName="bob"
        onClick={vi.fn()}
      />,
    );
    const visibleNames = Array.from(container.querySelectorAll('button > span[title]')).map(
      (s) => s.getAttribute('title'),
    );
    // bob pinned first, then alice + carol in their original order.
    expect(visibleNames).toEqual(['bob', 'alice', 'carol']);
  });

  it('passes the isMe prop only to the current user\'s pill', () => {
    const { container } = render(
      <UserPillRow
        users={[u('alice'), u('me')]}
        myUserName="me"
        onClick={vi.fn()}
      />,
    );
    const pills = container.querySelectorAll('button > span[title]');
    // The pill carrying the pillMe class is the one for "me".
    const mePill = Array.from(pills).find((p) => p.getAttribute('title') === 'me');
    const otherPill = Array.from(pills).find((p) => p.getAttribute('title') === 'alice');
    expect(mePill?.getAttribute('class')).toMatch(/pillMe/);
    expect(otherPill?.getAttribute('class')).not.toMatch(/pillMe/);
  });

  it('multiplies the progress fraction by 100 when passing to UserPill', () => {
    const { container } = render(
      <UserPillRow users={[u('alice', 0.42)]} onClick={vi.fn()} />,
    );
    const style = container.querySelector('button > span[title="alice"]')?.getAttribute('style') ?? '';
    expect(style).toContain('--progress: 42%');
  });

  it('fires onClick when the row button is clicked', () => {
    const onClick = vi.fn();
    render(<UserPillRow users={[u('alice')]} onClick={onClick} />);
    screen.getByRole('button').click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('exposes the room user count via the aria-label', () => {
    render(<UserPillRow users={[u('a'), u('b'), u('c')]} onClick={vi.fn()} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
      'Show all 3 users in room',
    );
  });
});
