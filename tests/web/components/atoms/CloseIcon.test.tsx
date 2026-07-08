// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CloseIcon } from '../../../../web/app/src/components/atoms/CloseIcon';

afterEach(() => {
  cleanup();
});

describe('CloseIcon', () => {
  it('renders an SVG with default size 14 and stroke-width 2', () => {
    const { container } = render(<CloseIcon />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('14');
    expect(svg?.getAttribute('height')).toBe('14');
    const path = container.querySelector('path');
    expect(path?.getAttribute('stroke-width')).toBe('2');
  });

  it('honors a custom size prop', () => {
    const { container } = render(<CloseIcon size={24} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('24');
    expect(svg?.getAttribute('height')).toBe('24');
  });

  it('honors a custom strokeWidth prop (the 2.5 tag-chip variant)', () => {
    const { container } = render(<CloseIcon strokeWidth={2.5} />);
    expect(container.querySelector('path')?.getAttribute('stroke-width')).toBe('2.5');
  });

  it('applies the className to the svg', () => {
    const { container } = render(<CloseIcon className="custom-class" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toBe('custom-class');
  });

  // Decorative -- the surrounding <button> carries the aria-label.
  it('is marked aria-hidden so the surrounding button label owns accessibility', () => {
    const { container } = render(<CloseIcon />);
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
