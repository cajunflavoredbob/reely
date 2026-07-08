// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Logo } from '../../../../web/app/src/components/atoms/Logo';

// Smoke test for the jsdom + @testing-library/react harness (audit 13
// #338 web-layer setup batch). Pins three things:
//   1. The jsdom environment override works via the
//      `// @vitest-environment jsdom` directive at the top of the file
//      (no global vitest config change needed).
//   2. CSS modules import cleanly under vitest's default transform
//      (vitest stubs CSS files to proxy objects -- `styles.root`
//      becomes the string "root" -- no extra config required).
//   3. React 18's `useId` works in the jsdom environment (it would
//      throw or duplicate ids without a real React DOM render).
//
// Logo was chosen as the target because it exercises useId (the
// per-render gradient id that audit 12 #195 pinned), React.memo (audit
// 14 #334), conditional render of the wordmark, and prop variations
// (size, withWord). Other Atoms (CloseIcon, ProviderIcon, etc.) get
// their own coverage in follow-up batches now that the harness is
// proven.

afterEach(() => {
  // RTL's `cleanup` isn't auto-wired without vitest globals; call
  // explicitly so each test starts with a fresh DOM.
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

  // Audit 12 #195: SVG ids are global; without useId per Logo, two
  // Logos on the same page would collide on the linearGradient id and
  // the second one would render with the first's gradient (or break
  // when the first unmounted). Pin the uniqueness here.
  it('gives each rendered Logo a unique gradient id (audit 12 #195)', () => {
    const { container: a } = render(<Logo />);
    const { container: b } = render(<Logo />);
    const idA = a.querySelector('linearGradient')?.getAttribute('id');
    const idB = b.querySelector('linearGradient')?.getAttribute('id');
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
  });

  it('scales the wordmark with the size prop (90% of size)', () => {
    render(<Logo size={100} />);
    const word = screen.getByText('reely');
    // React inlines style as a CSS string; check via the rendered style
    // attribute. Logo sets fontSize = size * 0.9 -> 90px.
    expect(word.getAttribute('style')).toContain('font-size: 90px');
  });
});
