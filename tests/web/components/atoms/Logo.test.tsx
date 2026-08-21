// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Logo } from '../../../../web/app/src/components/atoms/Logo';
import {
  GLYPH_PATH,
  GRADIENT,
  GRADIENT_STOPS,
  MARK_TRANSFORM,
  MARK_VIEWBOX,
} from '../../../../web/app/src/components/atoms/markGeometry';

// jsdom + RTL harness smoke test. Pins the @vitest-environment directive,
// CSS-module stubbing, and useId under jsdom. Logo is the target because it
// exercises all three plus React.memo and prop variations.

afterEach(() => {
  // RTL's `cleanup` isn't auto-wired without vitest globals.
  cleanup();
});

describe('Logo (jsdom + RTL smoke test)', () => {
  it('renders the "reely" wordmark by default', () => {
    render(<Logo />);
    expect(screen.getByText('reely')).toBeDefined();
  });

  it('renders the SVG mark', () => {
    const { container } = render(<Logo />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
  });

  it('omits the wordmark when withWord is false', () => {
    render(<Logo withWord={false} />);
    expect(screen.queryByText('reely')).toBeNull();
  });

  it('sets the SVG dimensions from the size prop', () => {
    const { container } = render(<Logo size={64} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('64');
    expect(svg?.getAttribute('height')).toBe('64');
  });

  // SVG ids are global: two Logos sharing a linearGradient id means the second
  // renders with the first's gradient, or breaks when the first unmounts.
  it('gives each rendered Logo a unique gradient id', () => {
    const { container: a } = render(<Logo />);
    const { container: b } = render(<Logo />);
    const idA = a.querySelector('linearGradient')?.getAttribute('id');
    const idB = b.querySelector('linearGradient')?.getAttribute('id');
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });

  // Everything above passes even if the artwork is replaced wholesale. These
  // pin the drawing itself against the generated geometry.
  it('draws the mark from the generated geometry', () => {
    const { container } = render(<Logo />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe(MARK_VIEWBOX);
    expect(container.querySelector(`g[transform="${MARK_TRANSFORM}"]`)).not.toBeNull();
    expect(container.querySelector('path')?.getAttribute('d')).toBe(GLYPH_PATH);
  });

  it('points the top card at a gradient that actually exists', () => {
    // A rect pointing at a missing paint server renders unfilled instead of
    // throwing, and the top card is the whole mark.
    const { container } = render(<Logo />);
    const rects = [...container.querySelectorAll('rect')];
    const top = rects.at(-1);
    const fill = top?.getAttribute('fill') ?? '';
    const id = fill.match(/^url\(#(.+)\)$/)?.[1];
    expect(id).toBeTruthy();
    expect(container.querySelector(`linearGradient[id="${id}"]`)).not.toBeNull();
  });

  it('renders the gradient stops the brand assets declare', () => {
    const { container } = render(<Logo />);
    const stops = [...container.querySelectorAll('stop')].map((s) => ({
      offset: s.getAttribute('offset'),
      color: s.getAttribute('stop-color'),
    }));
    expect(stops).toEqual(GRADIENT_STOPS.map((s) => ({ offset: s.offset, color: s.color })));
  });

  it('leaves the gradient in objectBoundingBox units, as the assets declare', () => {
    // userSpaceOnUse with the master's endpoint numbers is not equivalent:
    // bounding-box shears the axis by the card's 300x420 aspect, running the
    // in-app mark ~19 degrees off the favicon beside it.
    const { container } = render(<Logo />);
    const grad = container.querySelector('linearGradient');
    expect(grad?.getAttribute('gradientUnits')).toBeNull();
    // Against the generated values, not literals: '100%' here would restate
    // Logo.tsx and miss the master changing its gradient direction.
    expect(grad?.getAttribute('x1')).toBe(GRADIENT.x1);
    expect(grad?.getAttribute('y1')).toBe(GRADIENT.y1);
    expect(grad?.getAttribute('x2')).toBe(GRADIENT.x2);
    expect(grad?.getAttribute('y2')).toBe(GRADIENT.y2);
  });

  it('scales the wordmark with the size prop (90% of size)', () => {
    render(<Logo size={100} />);
    const word = screen.getByText('reely');
    // React inlines style as a CSS string. fontSize = size * 0.9 -> 90px.
    expect(word.getAttribute('style')).toContain('font-size: 90px');
  });
});
