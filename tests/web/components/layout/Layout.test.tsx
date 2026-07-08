// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Layout } from '../../../../web/app/src/components/layout/Layout';

// Layout is a thin wrapper: <section> + optional Logo + children +
// optional className override. The component lives on its own so the
// brand mark stays consistent across every full-screen view.

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
    // Logo renders the "reely" wordmark by default.
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

  // Default class still applied even with no override (the screenLayout
  // CSS module class). The string-concat in the source includes an
  // empty trailing space when className is undefined -- pin the no-crash
  // behavior so a future change to template-literal building doesn't
  // accidentally drop the default class.
  it('keeps the screenLayout default class when no className is provided', () => {
    const { container } = render(<Layout>x</Layout>);
    const section = container.querySelector('section');
    expect(section?.getAttribute('class')).toMatch(/screenLayout/);
  });
});
