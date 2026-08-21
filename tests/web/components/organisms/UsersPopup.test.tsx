// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UsersPopup } from '../../../../web/app/src/components/organisms/UsersPopup';
import type { UserProgress } from '../../../../types/reely';

// Room-roster overlay behind UserPillRow. Pure presentation: sorts me first
// then by descending progress, dismisses on backdrop click, and its Leave
// button fires onLeave plus onClose.

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
    // The title spans two elements, so assert on the heading's textContent.
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
    // Math.round(progress * 100) + "%".
    expect(container.textContent).toContain('40%');
    expect(container.textContent).toContain('75%');
  });

  // Pinning me regardless of my own progress keeps a stable anchor in a
  // crowded room.
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
    // 'me' first, then alice .9, carol .6, bob .1.
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

  // The dialog stopPropagation()s, so clicks inside never reach the backdrop's
  // onClick.
  it('clicking the backdrop fires onClose; clicking the dialog does not', () => {
    const onClose = vi.fn();
    const { container } = render(
      <UsersPopup users={[u('a')]} onClose={onClose} onLeave={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    // The backdrop is the root of the rendered tree.
    const backdrop = container.firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The popup self-dismisses so the parent has nothing to coordinate.
  it('clicking the Leave button fires onLeave AND onClose (popup self-dismisses)', () => {
    const onClose = vi.fn();
    const onLeave = vi.fn();
    render(<UsersPopup users={[u('a')]} onClose={onClose} onLeave={onLeave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape fires onClose (useEscape hook)', () => {
    const onClose = vi.fn();
    render(<UsersPopup users={[u('a')]} onClose={onClose} onLeave={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The server substitutes data-version into <body> at request time, and
  // APP_VERSION reads it at module load. resetModules + dynamic re-import is
  // the only way to get a fresh read after setting body.dataset.version.
  it('renders the version label from document.body.dataset.version', async () => {
    document.body.dataset.version = '0.5.4';
    vi.resetModules();
    const { UsersPopup: Fresh } = await import(
      '../../../../web/app/src/components/organisms/UsersPopup'
    );
    render(<Fresh users={[u('a')]} onClose={vi.fn()} onLeave={vi.fn()} />);
    expect(screen.getByText('v0.5.4')).toBeDefined();
    // Leave the next module load seeing no version, exercising the other branch.
    delete document.body.dataset.version;
  });
});
