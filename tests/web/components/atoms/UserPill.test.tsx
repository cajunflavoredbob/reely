// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UserPill } from '../../../../web/app/src/components/atoms/UserPill';

afterEach(() => {
  cleanup();
});

describe('UserPill', () => {
  it('renders the userName', () => {
    render(<UserPill userName="alice" />);
    expect(screen.getByText('alice')).toBeDefined();
  });

  it('uses the userName as the title (tooltip) so the full name is recoverable on hover', () => {
    const { container } = render(<UserPill userName="alice" />);
    expect(container.querySelector('span')?.getAttribute('title')).toBe('alice');
  });

  // Layout cap: pills longer than 14 chars get truncated to 13 + "…",
  // with the full name preserved in title=. UsersPopup still has the
  // full name visible.
  it('truncates names longer than 14 chars (TRUNCATE_AT) with an ellipsis', () => {
    render(<UserPill userName="taylor-swift-13-fan" />);
    expect(screen.queryByText('taylor-swift-13-fan')).toBeNull();
    // slice(0, TRUNCATE_AT - 1) = first 13 chars, then '…'.
    expect(screen.getByText('taylor-swift-…')).toBeDefined();
    // Full name still recoverable via title.
    const { container } = render(<UserPill userName="taylor-swift-13-fan" />);
    expect(container.querySelector('span[title="taylor-swift-13-fan"]')).not.toBeNull();
  });

  it('does NOT truncate exactly-14-character names', () => {
    render(<UserPill userName="abcdefghijklmn" />);
    expect(screen.getByText('abcdefghijklmn')).toBeDefined();
  });

  // CSS-var-keyed type (audit 9 #117): inline style sets --hue (hash 0-359)
  // and --progress (% string), consumed by the stylesheet. Type intersection
  // catches typos like `--huee` at compile time; the test pins the runtime
  // values land in the style attribute.
  it('injects --hue and --progress as inline CSS variables', () => {
    const { container } = render(<UserPill userName="alice" progress={42} />);
    const pill = container.querySelector('span');
    const style = pill?.getAttribute('style') ?? '';
    // userHue('alice') = 29 (locked in tests/web/userHue.test.ts).
    expect(style).toContain('--hue: 29');
    expect(style).toContain('--progress: 42%');
  });

  it('clamps the progress prop to [0, 100]', () => {
    const over = render(<UserPill userName="a" progress={150} />);
    const overStyle = over.container.querySelector('span')?.getAttribute('style') ?? '';
    expect(overStyle).toContain('--progress: 100%');
    cleanup();

    const under = render(<UserPill userName="a" progress={-10} />);
    const underStyle = under.container.querySelector('span')?.getAttribute('style') ?? '';
    expect(underStyle).toContain('--progress: 0%');
  });

  it('defaults progress to 0 when not provided', () => {
    const { container } = render(<UserPill userName="alice" />);
    const style = container.querySelector('span')?.getAttribute('style') ?? '';
    expect(style).toContain('--progress: 0%');
  });

  it('adds the isMe modifier class only when isMe is true', () => {
    const me = render(<UserPill userName="alice" isMe />);
    expect(me.container.querySelector('span')?.getAttribute('class')).toMatch(/pillMe/);
    cleanup();

    const them = render(<UserPill userName="alice" />);
    expect(them.container.querySelector('span')?.getAttribute('class')).not.toMatch(/pillMe/);
  });
});
