// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Stub PlexLinks (uses the Zustand store) as a sentinel so this test
// file doesn't need to re-establish the store mock; PlexLinks has its
// own coverage in tests/web/components/atoms/PlexLinks.test.tsx.
vi.mock('../../../../web/app/src/components/atoms/PlexLinks', () => ({
  PlexLinks: () => <div data-testid="plex-links-stub" />,
}));

import { MatchMoment } from '../../../../web/app/src/components/organisms/MatchMoment';
import type { Match } from '../../../../types/reely';

const match = (over: Partial<Match> = {}): Match => ({
  media: {
    id: 'guid-1',
    type: 'movie',
    title: 'Dune',
    description: '',
    plexKey: '/library/metadata/123',
    posterUrl: '/api/poster/0/123/thumb',
    year: 2021,
    duration: 0,
    rating: 0,
    genres: [],
    // biome-ignore lint/suspicious/noExplicitAny: full Media shape not the point.
  } as any,
  users: ['alice', 'bob'],
  // biome-ignore lint/suspicious/noExplicitAny: any extra Match fields.
  ...(over as any),
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MatchMoment: toast variant (isBig=false)', () => {
  it('renders the toast with "New match" label + media title + poster + dismiss button', () => {
    render(<MatchMoment match={match()} isBig={false} onDismiss={vi.fn()} />);
    expect(screen.getByText('New match')).toBeDefined();
    expect(screen.getByText('Dune')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDefined();
    // Poster img is in the toast variant too.
    const img = screen.getByAltText('Dune') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/poster/0/123/thumb');
  });

  it('omits the poster img when posterUrl is undefined', () => {
    const m = match();
    // biome-ignore lint/suspicious/noExplicitAny: in-test mutation to exercise the no-poster branch.
    (m.media as any).posterUrl = undefined;
    render(<MatchMoment match={m} isBig={false} onDismiss={vi.fn()} />);
    expect(screen.queryByAltText('Dune')).toBeNull();
  });

  // 0.5.2: onDismiss now fires AFTER the slide-fade exit animation
  // completes (was synchronous). 0.5.4: exit duration bumped 200 ->
  // 350ms (ry-slide-fade-out). Test advances the auto-dismiss timer
  // (3s) THEN the exit timer (350ms) to observe the parent's
  // onDismiss callback. Drift between this value and TOAST_EXIT_MS
  // in MatchMoment.tsx would break this test loudly.
  it('auto-dismisses the toast after 3 seconds (plus the 350ms exit slide+fade)', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={false} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_999);
    expect(onDismiss).not.toHaveBeenCalled();
    // Cross the 3s threshold -- exit animation starts, onDismiss not yet fired.
    vi.advanceTimersByTime(2);
    expect(onDismiss).not.toHaveBeenCalled();
    // Advance through the exit-slide+fade duration -- now onDismiss fires.
    vi.advanceTimersByTime(350);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-dismiss when isBig is true (the big-celebration overlay holds until explicitly dismissed)', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={true} onDismiss={onDismiss} />);
    vi.advanceTimersByTime(10_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  // 0.5.2: dismiss-button click triggers exit animation; onDismiss
  // fires after the slide-fade (was synchronous). 0.5.4: 200 -> 350ms.
  it('clicking the Dismiss button fires onDismiss after the 350ms exit slide+fade', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={false} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    // Exit animation in flight; onDismiss not yet fired.
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // 0.5.2: re-entry guard on requestDismiss. A double-click on the X
  // (or the auto-timer firing during a manual click) MUST NOT fire
  // onDismiss twice. Without the `if (exiting) return;` guard, the
  // second trigger would schedule a duplicate setTimeout that fires
  // independently.
  it('does NOT fire onDismiss twice when dismiss is triggered repeatedly', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={false} onDismiss={onDismiss} />);
    const btn = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    vi.advanceTimersByTime(500);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // 0.5.7: replaced=true means a new match has arrived and is sliding
  // in on top of this one. The auto-dismiss timer is intentionally
  // skipped -- the parent (Room.tsx) auto-prunes the demoted instance
  // ~400ms after demotion, so starting an exit slide that the unmount
  // would cut short is wasted motion + visual jank.
  it('does NOT auto-dismiss when replaced is true', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={false} onDismiss={onDismiss} replaced />);
    vi.advanceTimersByTime(5_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  // 0.5.7: replaced applies .toastReplaced on the toast div so the CSS
  // fade-out animation kicks in (200ms opacity 1 -> 0). Without the
  // class, no fade. CSS Module hashing means we match on substring.
  it('applies the toastReplaced class when replaced is true', () => {
    const { container } = render(
      <MatchMoment match={match()} isBig={false} onDismiss={vi.fn()} replaced />,
    );
    // The toast div is the one with .toast (NOT .toastSlot which is its
    // parent wrapper). Both classes are on the rendered tree; the
    // :not() filter selects the inner toast.
    const toast = container.querySelector('[class*="toast_"]:not([class*="toastSlot"])');
    expect(toast?.className).toMatch(/toastReplaced/);
  });

  // useEscape gates on isBig (passed as the second arg). The toast variant
  // intentionally does NOT respond to Escape -- only the big celebration
  // overlay does. Pin both directions.
  it('does NOT respond to Escape in the toast variant', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={false} onDismiss={onDismiss} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('MatchMoment: big variant (isBig=true)', () => {
  it('renders the celebration overlay with headline + subline + poster + confetti', () => {
    const { container } = render(
      <MatchMoment match={match()} isBig={true} onDismiss={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/match/);
    // Confetti is a fixed 20-piece array.
    const confetti = container.querySelectorAll('[class*="confettiPiece"]');
    expect(confetti.length).toBe(20);
  });

  it('uses 2-user subline copy for exactly 2 matchers', () => {
    render(<MatchMoment match={match({ users: ['alice', 'bob'] })} isBig={true} onDismiss={vi.fn()} />);
    expect(screen.getByText('You both like this one.')).toBeDefined();
  });

  it('uses N-user subline copy for 3+ matchers', () => {
    render(<MatchMoment match={match({ users: ['alice', 'bob', 'carol'] })} isBig={true} onDismiss={vi.fn()} />);
    expect(screen.getByText('3 of you like this one.')).toBeDefined();
  });

  it('renders one Avatar per matcher', () => {
    const { container } = render(
      <MatchMoment match={match({ users: ['alice', 'bob', 'carol'] })} isBig={true} onDismiss={vi.fn()} />,
    );
    // Each Avatar is its own <svg>. There may be other svgs (the toast
    // dismiss icon doesn't render in big mode); count those inside the
    // avatar row container.
    const avatarSvgs = container.querySelectorAll('[class*="avatarRow"] svg');
    expect(avatarSvgs.length).toBe(3);
  });

  it('falls back to a title-as-placeholder div when posterUrl is undefined', () => {
    const m = match();
    // biome-ignore lint/suspicious/noExplicitAny: in-test mutation to exercise the no-poster branch.
    (m.media as any).posterUrl = undefined;
    const { container } = render(<MatchMoment match={m} isBig={true} onDismiss={vi.fn()} />);
    expect(container.querySelector('img')).toBeNull();
    // Placeholder div contains the title.
    expect(screen.getByText('Dune')).toBeDefined();
  });

  it('renders the PlexLinks stub (real PlexLinks covered in its own test)', () => {
    render(<MatchMoment match={match()} isBig={true} onDismiss={vi.fn()} />);
    expect(screen.getByTestId('plex-links-stub')).toBeDefined();
  });

  it('clicking "Keep swiping" fires onDismiss', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={true} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep swiping' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // Backdrop click dismisses; clicks inside the actions wrapper do NOT
  // bubble (stopPropagation), so the "Open in Plex" link doesn't double-
  // fire onDismiss when clicked.
  it('clicking the overlay backdrop fires onDismiss', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={true} onDismiss={onDismiss} />);
    // The overlay has role=dialog.
    fireEvent.click(screen.getByRole('dialog'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('responds to Escape in the big variant (useEscape gated on isBig)', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={true} onDismiss={onDismiss} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
