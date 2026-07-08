// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UsersPopup } from '../../../../web/app/src/components/organisms/UsersPopup';
import type { UserProgress } from '../../../../types/reely';

// UsersPopup is the room-roster overlay shown when the user taps the
// UserPillRow. Pure presentation + a couple of dismiss paths -- no store,
// no timers. Sorts users by "me first, then descending progress" (audit
// 14 #333), wraps the dialog in a click-outside-dismissable backdrop,
// and exposes a Leave button that fires both onLeave + onClose.

const u = (userName: string, progress = 0): UserProgress => ({
  user: { userName },
  progress,
});

afterEach(() => {
  cleanup();
});

describe('UsersPopup', () => {
  it('renders the title with the user count', () => {
    render(
      <UsersPopup users={[u('a'), u('b'), u('c')]} onClose={vi.fn()} onLeave={vi.fn()} />,
    );
    // Title splits "In this room " + "(3)" across two elements; assert via
    // the heading's full textContent rather than getByText.
    const title = screen.getByRole('heading', { level: 2 });
    expect(title.textContent).toContain('In this room');
    expect(title.textContent).toContain('(3)');
  });

  it('renders one row per user with name + progress percentage', () => {
    const { container } = render(
      <UsersPopup
        users={[u('alice', 0.4), u('bob', 0.75)]}
        onClose={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    const rows = container.querySelectorAll('li');
    expect(rows.length).toBe(2);
    // Progress text: Math.round(progress * 100) + "%".
    expect(container.textContent).toContain('40%');
    expect(container.textContent).toContain('75%');
  });

  // "Me first, then descending progress." The current user is pinned to
  // the top regardless of their own progress so they always have a stable
  // anchor for finding themselves in a crowded room.
  it('pins the current user to the top and sorts the rest by descending progress', () => {
    const { container } = render(
      <UsersPopup
        users={[
          u('alice', 0.9),
          u('bob', 0.1),
          u('me', 0.5),
          u('carol', 0.6),
        ]}
        myUserName="me"
        onClose={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    const names = Array.from(container.querySelectorAll('li > span[title]')).map(
      (s) => s.getAttribute('title'),
    );
    // 'me' pinned first; rest in descending progress order (alice .9, carol .6, bob .1).
    expect(names).toEqual(['me', 'alice', 'carol', 'bob']);
  });

  it('forwards isMe only to the current user\'s pill', () => {
    const { container } = render(
      <UsersPopup
        users={[u('alice'), u('me')]}
        myUserName="me"
        onClose={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
    const mePill = container.querySelector('span[title="me"]');
    const otherPill = container.querySelector('span[title="alice"]');
    expect(mePill?.getAttribute('class')).toMatch(/pillMe/);
    expect(otherPill?.getAttribute('class')).not.toMatch(/pillMe/);
  });

  it('clicking the close button fires onClose', () => {
    const onClose = vi.fn();
    render(<UsersPopup users={[u('a')]} onClose={onClose} onLeave={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Backdrop click closes; dialog click does NOT (the dialog has a
  // stopPropagation handler so clicks inside don't bubble up to the
  // backdrop's onClick).
  it('clicking the backdrop fires onClose; clicking the dialog does not', () => {
    const onClose = vi.fn();
    const { container } = render(
      <UsersPopup users={[u('a')]} onClose={onClose} onLeave={vi.fn()} />,
    );
    // The dialog is inside the backdrop; clicking the dialog should NOT
    // dismiss.
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    // Clicking the backdrop directly should dismiss. The backdrop is the
    // outermost div (the root of the rendered tree).
    const backdrop = container.firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Leave fires onLeave THEN onClose -- the popup self-dismisses so the
  // parent doesn't have to coordinate. Both must be called once.
  it('clicking the Leave button fires onLeave AND onClose (popup self-dismisses)', () => {
    const onClose = vi.fn();
    const onLeave = vi.fn();
    render(<UsersPopup users={[u('a')]} onClose={onClose} onLeave={onLeave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // useEscape: shared keyboard dismissal pattern across FilterPanel +
  // MatchMoment + UsersPopup. Pressing Esc on the document fires onClose.
  it('pressing Escape fires onClose (useEscape hook)', () => {
    const onClose = vi.fn();
    render(<UsersPopup users={[u('a')]} onClose={onClose} onLeave={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // 0.5.4: version label rendered from document.body.dataset.version
  // (substituted at request time by the server from <body
  // data-version="${version}">). APP_VERSION is read at module load --
  // resetModules + dynamic re-import forces a fresh read AFTER setting
  // body.dataset.version, which is how this test simulates the production
  // template substitution.
  it('renders the version label from document.body.dataset.version', async () => {
    document.body.dataset.version = '0.5.4';
    vi.resetModules();
    const { UsersPopup: Fresh } = await import(
      '../../../../web/app/src/components/organisms/UsersPopup'
    );
    render(<Fresh users={[u('a')]} onClose={vi.fn()} onLeave={vi.fn()} />);
    // getByText throws if not found; toBeDefined matches the rest of
    // this file (no jest-dom matchers imported here).
    expect(screen.getByText('v0.5.4')).toBeDefined();
    // Clean up so the next test's module load sees no version (matches
    // jsdom default + ensures the conditional-render branch is also
    // exercised across the suite).
    delete document.body.dataset.version;
  });
});
