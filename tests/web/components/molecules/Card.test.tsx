// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// `isIOS` is a module-level const computed at import, so it is proxied through
// a mutable object. PlexLinks is stubbed to a sentinel: it needs the Zustand
// store and has its own coverage in atoms/PlexLinks.test.tsx.
const { isIOSMock } = vi.hoisted(() => ({ isIOSMock: { current: false } }));

vi.mock('../../../../web/app/src/utils/platform', () => ({
  get isIOS() {
    return isIOSMock.current;
  },
}));

vi.mock('../../../../web/app/src/components/atoms/PlexLinks', () => ({
  PlexLinks: () => <div data-testid="plex-links-stub" />,
}));

import { Card } from '../../../../web/app/src/components/molecules/Card';
import type { Media } from '../../../../types/reely';

const media = (over: Partial<Media> = {}): Media =>
  ({
    id: 'guid-1',
    type: 'movie',
    title: 'Test Title',
    description: 'A test description',
    plexKey: '/library/metadata/123',
    posterUrl: '/api/poster/0/123/thumb',
    year: 2024,
    duration: 90 * 60_000,
    rating: 8.4,
    contentRating: 'PG-13',
    genres: ['Action', 'Drama'],
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: full Media shape isn't the point in these renders.
  }) as any;

beforeEach(() => {
  isIOSMock.current = false;
  // posterSrc reads document.body.dataset.rootPath; jsdom's real document is
  // enough (undefined coalesces to ''). Never stub document wholesale: a plain
  // object breaks the createElement RTL renders through.
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Card: default rendering (no href, title visible)', () => {
  it('renders the poster img when a posterUrl is present', () => {
    const { container } = render(<Card media={media()} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('/api/poster/0/123/thumb');
    expect(img?.getAttribute('alt')).toBe('Test Title poster');
  });

  it('omits the poster img entirely when posterUrl is undefined', () => {
    const { container } = render(<Card media={media({ posterUrl: undefined })} />);
    expect(container.querySelector('img')).toBeNull();
  });

  // A deleted or re-scanned Plex item, or a rate-limited poster request, used
  // to leave the browser's broken-image glyph sitting over the card.
  it('drops the poster img when the image fails to load', () => {
    const { container } = render(<Card media={media()} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above.
    fireEvent.error(img!);
    expect(container.querySelector('img')).toBeNull();
    // The title overlay is the fallback, so the card still identifies itself.
    expect(screen.getByText('Test Title (2024)')).toBeDefined();
  });

  // Failure is tracked per src, so the next media in the stack is not tarred
  // with the previous one's broken poster.
  it('trusts a new poster src after a previous one failed', () => {
    const { container, rerender } = render(<Card media={media()} />);
    // biome-ignore lint/style/noNonNullAssertion: the poster img is rendered above.
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();

    rerender(<Card media={media({ posterUrl: '/api/poster/0/456/thumb' })} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/poster/0/456/thumb',
    );
  });

  it('renders the title with year in parens for movie type', () => {
    render(<Card media={media({ title: 'Dune', year: 2021 })} />);
    expect(screen.getByText('Dune (2021)')).toBeDefined();
  });

  // A Plex item whose agent match hasn't run has no year; the template literal
  // used to stringify it as "Dune (undefined)".
  it('renders the bare title when the movie has no year', () => {
    render(<Card media={media({ title: 'Dune', year: undefined })} />);
    expect(screen.getByText('Dune')).toBeDefined();
    expect(screen.queryByText('Dune (undefined)')).toBeNull();
  });

  it('renders the bare title in the more-info panel when the movie has no year', () => {
    render(<Card media={media({ title: 'Dune', year: undefined })} />);
    fireEvent.click(screen.getByRole('button', { name: 'More info' }));
    expect(screen.getByText('Dune')).toBeDefined();
    expect(screen.queryByText('Dune (undefined)')).toBeNull();
  });

  it('renders the meta line with year + duration + rating', () => {
    const { container } = render(
      <Card media={media({ year: 2024, duration: 90 * 60_000, rating: 8.4 })} />,
    );
    const meta = container.querySelector('p:nth-of-type(2)');
    expect(meta?.textContent).toBe('2024 · 1H 30M · ★ 8.4');
  });

  it('omits the duration segment when duration is 0', () => {
    const { container } = render(
      <Card media={media({ duration: 0, rating: 8.4 })} />,
    );
    const meta = container.querySelector('p:nth-of-type(2)');
    expect(meta?.textContent).not.toContain('M');
    expect(meta?.textContent).toContain('8.4');
  });

  it('omits the rating segment when rating is 0', () => {
    const { container } = render(
      <Card media={media({ rating: 0 })} />,
    );
    const meta = container.querySelector('p:nth-of-type(2)');
    expect(meta?.textContent).not.toContain('★');
  });
});

describe('Card: info toggle (no href -> swipe card)', () => {
  it('renders the info toggle button by default', () => {
    render(<Card media={media()} />);
    expect(screen.getByRole('button', { name: 'More info' })).toBeDefined();
  });

  // fireEvent.click, not Element.click: RTL wraps it in act() so the state
  // update flushes before the assertions read the DOM.
  it('clicking the info button flips to the more-info view (genres + description + PlexLinks)', () => {
    render(<Card media={media()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More info' }));
    expect(screen.getByText('A test description')).toBeDefined();
    expect(screen.getByText('Action')).toBeDefined();
    expect(screen.getByText('Drama')).toBeDefined();
    expect(screen.getByTestId('plex-links-stub')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Show title' })).toBeDefined();
  });

  it('clicking again flips back to the title view', () => {
    render(<Card media={media()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More info' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show title' }));
    expect(screen.getByRole('button', { name: 'More info' })).toBeDefined();
    expect(screen.queryByText('A test description')).toBeNull();
  });

  it('preventDefault is called on the info-button click (no parent navigation)', () => {
    let defaultPreventedSeen = false;
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test wrapper to observe defaultPrevented.
      // biome-ignore lint/a11y/useKeyWithClickEvents: test wrapper to observe defaultPrevented.
      <div onClick={(e) => { defaultPreventedSeen = e.defaultPrevented; }}>
        <Card media={media()} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More info' }));
    expect(defaultPreventedSeen).toBe(true);
  });

  it('renders the more-info meta line with the full segment chain (year + duration + rating + contentRating)', () => {
    render(<Card media={media()} />);
    fireEvent.click(screen.getByRole('button', { name: 'More info' }));
    // All four segments joined with " · ".
    expect(screen.getByText('2024 · 1H 30M · ★ 8.4 · PG-13')).toBeDefined();
  });
});

describe('Card: href variant (link card, no info toggle)', () => {
  it('renders as an <a> when href is provided', () => {
    const { container } = render(<Card media={media()} href="/some/path" />);
    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('href')).toBe('/some/path');
  });

  it('uses target="_blank" on non-iOS for the link card', () => {
    isIOSMock.current = false;
    const { container } = render(<Card media={media()} href="/some/path" />);
    expect(container.querySelector('a')?.getAttribute('target')).toBe('_blank');
  });

  it('uses target="_self" on iOS', () => {
    isIOSMock.current = true;
    const { container } = render(<Card media={media()} href="/some/path" />);
    expect(container.querySelector('a')?.getAttribute('target')).toBe('_self');
  });

  it('omits the info-toggle button when rendered as a link card', () => {
    render(<Card media={media()} href="/some/path" />);
    expect(screen.queryByRole('button', { name: 'More info' })).toBeNull();
  });

  it('sets rel="noopener noreferrer" on the external link', () => {
    const { container } = render(<Card media={media()} href="/some/path" />);
    expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
