// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Mocks the store (room + config) and useLocalPlexReachable. importActual
// keeps the real buildPlexLinks, covered in tests/web/plexLinks.test.ts.
const { useStoreMock, useLocalPlexReachableMock } = vi.hoisted(() => ({
  useStoreMock: vi.fn(),
  useLocalPlexReachableMock: vi.fn(),
}));

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  useDispatch: vi.fn(),
  useSelector: vi.fn(),
  createStore: vi.fn(),
}));

vi.mock('../../../../web/app/src/utils/plexLinks', async () => {
  const actual = await vi.importActual<typeof import('../../../../web/app/src/utils/plexLinks')>(
    '../../../../web/app/src/utils/plexLinks',
  );
  return { ...actual, useLocalPlexReachable: useLocalPlexReachableMock };
});

import { MatchesList } from '../../../../web/app/src/components/organisms/MatchesList';
import type { Match } from '../../../../types/reely';

// biome-ignore lint/suspicious/noExplicitAny: full Match shape isn't the point in these renders.
const makeMatch = (id: string, matchedAt: number, over: Partial<any> = {}): Match => ({
  media: {
    id,
    type: 'movie',
    title: `Title ${id}`,
    description: '',
    plexKey: `/library/metadata/${id}`,
    posterUrl: `/api/poster/0/${id}/thumb`,
    year: 2024,
    duration: 90 * 60_000,
    rating: 8.0,
    genres: ['Action', 'Drama', 'Sci-Fi'],
    // biome-ignore lint/suspicious/noExplicitAny: full Media shape not the point.
  } as any,
  users: ['alice', 'bob'],
  matchedAt,
  // biome-ignore lint/suspicious/noExplicitAny: extra Match fields.
  ...(over as any),
});

// biome-ignore lint/suspicious/noExplicitAny: store slice shape in tests is loose.
const withState = (room: any, config: any = {}) => {
  useStoreMock.mockReturnValue([{ room, config }, vi.fn()]);
};

beforeEach(() => {
  useStoreMock.mockReset();
  useLocalPlexReachableMock.mockReset().mockReturnValue(undefined);
  withState(undefined);
});

afterEach(() => {
  cleanup();
});

describe('MatchesList: empty state', () => {
  it('renders the "no matches yet" empty state when room.matches is empty', () => {
    withState({ matches: [] });
    render(<MatchesList onClose={vi.fn()} />);
    expect(screen.getByText('No matches yet.')).toBeDefined();
    expect(screen.getByText(/Keep swiping/)).toBeDefined();
  });

  it('also renders the empty state when room is undefined entirely', () => {
    withState(undefined);
    render(<MatchesList onClose={vi.fn()} />);
    expect(screen.getByText('No matches yet.')).toBeDefined();
  });

  it('header shows count "0" with the "matches" accent', () => {
    withState({ matches: [] });
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    const h1 = container.querySelector('h1');
    expect(h1?.textContent).toContain('0');
    expect(h1?.textContent).toContain('matches');
  });
});

describe('MatchesList: populated state', () => {
  it('header shows the match count', () => {
    withState({
      matches: [
        makeMatch('a', 100),
        makeMatch('b', 200),
        makeMatch('c', 300),
      ],
    });
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    expect(container.querySelector('h1')?.textContent).toContain('3');
  });

  it('uses the singular noun for exactly one match', () => {
    withState({ matches: [makeMatch('a', 100)] });
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    expect(container.querySelector('h1')?.textContent).toContain('1 match');
    expect(container.querySelector('h1')?.textContent).not.toContain('matches');
  });

  // Render order drives the staggered row-in animation below.
  it('sorts matches by descending matchedAt (newest first)', () => {
    withState({
      matches: [
        makeMatch('old', 100),
        makeMatch('new', 300),
        makeMatch('mid', 200),
      ],
    });
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    const titles = Array.from(container.querySelectorAll('p'))
      .map((p) => p.textContent)
      .filter((t) => t?.startsWith('Title '));
    expect(titles).toEqual(['Title new', 'Title mid', 'Title old']);
  });

  // Each row gets `${i * 40}ms`; a changed multiplier breaks the cascade.
  it('applies a sequential 40ms animationDelay per row', () => {
    withState({
      matches: [
        makeMatch('a', 300),
        makeMatch('b', 200),
        makeMatch('c', 100),
      ],
    });
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    const rows = container.querySelectorAll('[class*="matchRow"]');
    expect(rows.length).toBe(3);
    expect((rows[0] as HTMLElement).style.animationDelay).toBe('0ms');
    expect((rows[1] as HTMLElement).style.animationDelay).toBe('40ms');
    expect((rows[2] as HTMLElement).style.animationDelay).toBe('80ms');
  });

  // The cascade stops growing at row 10 (400ms). Unclamped, a 150-match
  // shortlist left its last row blank for 6 seconds after open.
  it('caps the animationDelay at 400ms for rows past the tenth', () => {
    withState({
      matches: Array.from({ length: 14 }, (_, i) => makeMatch(`m${i}`, 1_000 - i)),
    });
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    const rows = container.querySelectorAll('[class*="matchRow"]');
    expect(rows.length).toBe(14);
    expect((rows[9] as HTMLElement).style.animationDelay).toBe('360ms');
    expect((rows[10] as HTMLElement).style.animationDelay).toBe('400ms');
    expect((rows[13] as HTMLElement).style.animationDelay).toBe('400ms');
  });

  it('renders each row\'s title + meta (year + duration + rating)', () => {
    withState({ matches: [makeMatch('a', 100)] });
    render(<MatchesList onClose={vi.fn()} />);
    expect(screen.getByText('Title a')).toBeDefined();
    expect(screen.getByText('2024 · 1H 30M · ★ 8')).toBeDefined();
  });

  it('falls back to a title-as-placeholder when posterUrl is undefined', () => {
    const m = makeMatch('a', 100);
    // biome-ignore lint/suspicious/noExplicitAny: in-test mutation to exercise the no-poster branch.
    (m.media as any).posterUrl = undefined;
    withState({ matches: [m] });
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    expect(container.querySelector('img')).toBeNull();
    // Title appears as both the placeholder and the matchTitle p.
    expect(screen.getAllByText('Title a').length).toBeGreaterThan(0);
  });

  // Query through the wrapper: `[class*="genrePill"]` substring-matches the
  // genrePills container too, inflating the count by one.
  it('caps visible genre pills at 2 per row', () => {
    withState({
      matches: [
        makeMatch('a', 100), // fixture has 3 genres
      ],
    });
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    const pills = container.querySelectorAll('[class*="genrePills"] > span');
    expect(pills.length).toBe(2);
    expect(pills[0]?.textContent).toBe('Action');
    expect(pills[1]?.textContent).toBe('Drama');
  });

  it('caps visible avatars at 3 per row', () => {
    withState({
      matches: [
        makeMatch('a', 100, { users: ['alice', 'bob', 'carol', 'dave', 'erin'] }),
      ],
    });
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    const avatarRow = container.querySelector('[class*="avatarRow"]');
    // Avatars render as svg.
    const avatars = avatarRow?.querySelectorAll('svg') ?? [];
    expect(avatars.length).toBe(3);
  });
});

describe('MatchesList: Plex link per row', () => {
  it('renders the Plex link only when the config has a plexServerId', () => {
    withState({ matches: [makeMatch('a', 100)] }, { plexServerId: 'SRV1' });
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    const link = container.querySelector('a[class*="plexLink"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toContain('SRV1');
  });

  it('omits the Plex link when no plexServerId is configured', () => {
    withState({ matches: [makeMatch('a', 100)] }, {});
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    expect(container.querySelector('a[class*="plexLink"]')).toBeNull();
  });

  it('builds a local Plex URL when plexBaseUrl is set AND localReachable is true', () => {
    withState(
      { matches: [makeMatch('a', 100)] },
      { plexServerId: 'SRV1', plexBaseUrl: 'http://192.168.1.15:32400' },
    );
    useLocalPlexReachableMock.mockReturnValue(true);
    const { container } = render(<MatchesList onClose={vi.fn()} />);
    const href = container.querySelector('a[class*="plexLink"]')?.getAttribute('href') ?? '';
    expect(href).toContain('192.168.1.15:32400');
  });
});

describe('MatchesList: close', () => {
  it('clicking the close button fires onClose', () => {
    withState({ matches: [] });
    const onClose = vi.fn();
    render(<MatchesList onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
