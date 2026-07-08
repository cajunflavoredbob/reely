// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ProviderIcon } from '../../../../web/app/src/components/atoms/ProviderIcon';

afterEach(() => {
  cleanup();
});

describe('ProviderIcon', () => {
  it('renders the Plex chevron mark when type defaults to "plex"', () => {
    const { container } = render(<ProviderIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // Plex variant: two paths (chevron rings) inside a black circle.
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBe(2);
    expect(container.querySelector('circle')?.getAttribute('fill')).toBe('#000');
  });

  it('honors the size prop on the SVG dimensions', () => {
    const { container } = render(<ProviderIcon size={48} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('48');
    expect(svg?.getAttribute('height')).toBe('48');
  });

  // Future Emby/Jellyfin providers fall into the placeholder branch:
  // amber circle + the type's first character uppercased.
  it('falls back to a letter-on-amber-circle for unknown types (Emby/JF placeholder)', () => {
    const { container } = render(<ProviderIcon type="emby" />);
    const text = container.querySelector('text');
    expect(text?.textContent).toBe('E');
    expect(container.querySelector('circle')?.getAttribute('fill')).toBe('#EBAF00');
  });

  it('uppercases the first letter of the type for the placeholder', () => {
    const { container } = render(<ProviderIcon type="jellyfin" />);
    expect(container.querySelector('text')?.textContent).toBe('J');
  });

  // Decorative -- the provider identity is in surrounding text.
  it('is marked aria-hidden (decorative)', () => {
    const { container } = render(<ProviderIcon />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
