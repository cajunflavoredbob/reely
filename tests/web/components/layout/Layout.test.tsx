// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Layout } from '../../../../web/app/src/components/layout/Layout';

// Thin wrapper: <section> + optional Logo + children + className override.

afterEach(() => {
  cleanup();
});

describe('Layout', () => {
  it('renders its children', () => {
    render(
      <Layout>
        <span>inside</span>
      </Layout>,
    );
    expect(screen.getByText('inside')).toBeDefined();
  });

  it('renders the Logo by default (hideLogo defaults to false)', () => {
    render(<Layout>x</Layout>);
    // Logo renders the "reely" wordmark.
    expect(screen.getByText('reely')).toBeDefined();
  });

  it('hides the Logo when hideLogo is true', () => {
    render(<Layout hideLogo>x</Layout>);
    expect(screen.queryByText('reely')).toBeNull();
  });

  it('applies the provided className to the section element', () => {
    const { container } = render(<Layout className="extra-class">x</Layout>);
    const section = container.querySelector('section');
    expect(section?.getAttribute('class')).toContain('extra-class');
  });

  // The class string is built by concat; a rewrite must not drop the default.
  it('keeps the screenLayout default class when no className is provided', () => {
    const { container } = render(<Layout>x</Layout>);
    const section = container.querySelector('section');
    expect(section?.getAttribute('class')).toMatch(/screenLayout/);
  });
});
