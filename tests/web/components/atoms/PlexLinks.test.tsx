// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// Mock the Zustand store (config slice only) and the plexLinks utility's
// useLocalPlexReachable hook + the isIOS platform flag. buildPlexLinks
// itself is a pure function with its own coverage in
// tests/web/plexLinks.test.ts -- importActual keeps the real impl so the
// URL-building behavior under test (local vs app.plex.tv branch) isn't
// re-mocked here.
const { useStoreMock, useLocalPlexReachableMock, isIOSMock } = vi.hoisted(() => ({
  useStoreMock: vi.fn(),
  useLocalPlexReachableMock: vi.fn(),
  isIOSMock: { current: false },
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
  return {
    ...actual,
    useLocalPlexReachable: useLocalPlexReachableMock,
  };
});

// `isIOS` is a module-level const evaluated at import time. We can't stub
// navigator after-the-fact here (the module's already loaded by the time
// the first test runs), so we mock the whole platform module and proxy
// the value through an object the tests can mutate per case.
vi.mock('../../../../web/app/src/utils/platform', () => ({
  get isIOS() {
    return isIOSMock.current;
  },
}));

import { PlexLinks } from '../../../../web/app/src/components/atoms/PlexLinks';
import type { Media } from '../../../../types/reely';

// biome-ignore lint/suspicious/noExplicitAny: Config in tests is partial; full shape isn't the point.
const withConfig = (config: any) => {
  useStoreMock.mockReturnValue([{ config }, vi.fn()]);
};

const media = (over: Partial<Media> = {}): Media =>
  ({
    id: 'guid-1',
    type: 'movie',
    title: 'Test',
    description: '',
    plexKey: '/library/metadata/123',
    genres: [],
    duration: 0,
    rating: 0,
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: full Media shape isn't the point in these renders.
  }) as any;

beforeEach(() => {
  useStoreMock.mockReset();
  useLocalPlexReachableMock.mockReset().mockReturnValue(undefined);
  isIOSMock.current = false;
  withConfig({});
});

afterEach(() => {
  cleanup();
});

describe('PlexLinks', () => {
  it('renders nothing when the Plex serverId is unknown (config not yet received)', () => {
    withConfig({});
    const { container } = render(<PlexLinks media={media()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an <a> linking to app.plex.tv when no plexBaseUrl is configured', () => {
    withConfig({ plexServerId: 'SRV123' });
    const { container } = render(<PlexLinks media={media()} />);
    const a = container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('href')).toContain('app.plex.tv');
    expect(a?.getAttribute('href')).toContain('SRV123');
  });

  it('routes to the local Plex web UI when plexBaseUrl is set AND localReachable is true', () => {
    withConfig({ plexServerId: 'SRV123', plexBaseUrl: 'http://192.168.1.15:32400' });
    useLocalPlexReachableMock.mockReturnValue(true);
    const { container } = render(<PlexLinks media={media()} />);
    const href = container.querySelector('a')?.getAttribute('href') ?? '';
    expect(href).toContain('192.168.1.15:32400');
    expect(href).not.toContain('app.plex.tv');
  });

  it('falls back to app.plex.tv when localReachable is false even with plexBaseUrl set', () => {
    withConfig({ plexServerId: 'SRV123', plexBaseUrl: 'http://192.168.1.15:32400' });
    useLocalPlexReachableMock.mockReturnValue(false);
    const { container } = render(<PlexLinks media={media()} />);
    expect(container.querySelector('a')?.getAttribute('href')).toContain('app.plex.tv');
  });

  // iOS Safari quirk: target="_blank" opens a blank tab that never loads;
  // _self is required for the navigation to actually fire. Other platforms
  // get the standard new-tab behavior. Pinned for both directions.
  it('uses target="_self" on iOS (Safari new-tab quirk)', () => {
    isIOSMock.current = true;
    withConfig({ plexServerId: 'SRV123' });
    const { container } = render(<PlexLinks media={media()} />);
    expect(container.querySelector('a')?.getAttribute('target')).toBe('_self');
  });

  it('uses target="_blank" on non-iOS platforms', () => {
    isIOSMock.current = false;
    withConfig({ plexServerId: 'SRV123' });
    const { container } = render(<PlexLinks media={media()} />);
    expect(container.querySelector('a')?.getAttribute('target')).toBe('_blank');
  });

  // The wrapper div has a click handler that stopPropagation()s so clicks
  // on "Open in Plex" don't bubble up to parent overlays (MatchMoment's
  // overlay onClick dismisses the celebration). Verify the bubble is
  // stopped by clicking the link and observing a parent listener was NOT
  // notified.
  it('stops click propagation so parent overlay handlers do not fire', () => {
    withConfig({ plexServerId: 'SRV123' });
    const parentClick = vi.fn();
    const { container } = render(
      // biome-ignore lint/a11y/noStaticElementInteractions: test wrapper to observe propagation.
      // biome-ignore lint/a11y/useKeyWithClickEvents: test wrapper to observe propagation.
      <div onClick={parentClick}>
        <PlexLinks media={media()} />
      </div>,
    );
    const a = container.querySelector('a');
    a?.click();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('sets rel="noopener noreferrer" on the external link', () => {
    withConfig({ plexServerId: 'SRV123' });
    const { container } = render(<PlexLinks media={media()} />);
    expect(container.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
