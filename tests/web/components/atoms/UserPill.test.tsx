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

  // Layout cap. The full name stays recoverable via title=.
  it('truncates names longer than 14 chars (TRUNCATE_AT) with an ellipsis', () => {
    const { container } = render(<UserPill userName="taylor-swift-13-fan" />);
    expect(screen.queryByText('taylor-swift-13-fan')).toBeNull();
    // slice(0, TRUNCATE_AT - 1) = 13 chars, then '…'.
    expect(screen.getByText('taylor-swift-…')).toBeDefined();
    expect(container.querySelector('span[title="taylor-swift-13-fan"]')).not.toBeNull();
  });

  it('does NOT truncate exactly-14-character names', () => {
    render(<UserPill userName="abcdefghijklmn" />);
    expect(screen.getByText('abcdefghijklmn')).toBeDefined();
  });

  // Counting and cutting by code unit split an astral character in half and
  // rendered the replacement glyph next to the ellipsis.
  it('counts and cuts by code point, never leaving a lone surrogate', () => {
    const name = '🎬'.repeat(16);
    render(<UserPill userName={name} />);
    const label = screen.getByText(/🎬/).textContent ?? '';
    // Same 13-then-ellipsis rule as the ASCII case, counted in code points.
    expect(label).toBe(`${'🎬'.repeat(13)}…`);
    // A high surrogate with no low after it, or a low with no high before it.
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(LONE_SURROGATE.test(label)).toBe(false);
  });

  it('does NOT truncate a 14-code-point name made of astral characters', () => {
    const name = '🎬'.repeat(14);
    render(<UserPill userName={name} />);
    expect(screen.getByText(name)).toBeDefined();
  });

  // The stylesheet reads --hue (0-359) and --progress (% string) off the inline
  // style; typing catches `--huee` at compile time, this pins the values.
  it('injects --hue and --progress as inline CSS variables', () => {
    const { container } = render(<UserPill userName="alice" progress={42} />);
    const pill = container.querySelector('span');
    const style = pill?.getAttribute('style') ?? '';
    // userHue('alice') = 29, locked in tests/web/userHue.test.ts.
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
