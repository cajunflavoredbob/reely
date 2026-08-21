// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// PlexLinks needs the Zustand store, so stub it to a sentinel. It has its own
// coverage in tests/web/components/atoms/PlexLinks.test.tsx.
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

  // onDismiss fires only after the exit slide-fade, so the 350ms here must
  // track TOAST_EXIT_MS in MatchMoment.tsx.
  it('auto-dismisses the toast after 3 seconds (plus the 350ms exit slide+fade)', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={false} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_999);
    expect(onDismiss).not.toHaveBeenCalled();
    // Crossing 3s starts the exit animation, nothing more.
    vi.advanceTimersByTime(2);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-dismiss when isBig is true (the big-celebration overlay holds until explicitly dismissed)', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={true} onDismiss={onDismiss} />);
    vi.advanceTimersByTime(10_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('clicking the Dismiss button fires onDismiss after the 350ms exit slide+fade', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={false} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    // Exit animation in flight.
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(350);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // Without requestDismiss's `if (exiting) return;` guard, a second trigger
  // schedules a duplicate setTimeout that fires independently.
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

  // replaced means a newer match is sliding in on top. Room.tsx prunes the
  // demoted instance ~400ms later, so an exit slide would only be cut short.
  it('does NOT auto-dismiss when replaced is true', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={false} onDismiss={onDismiss} replaced />);
    vi.advanceTimersByTime(5_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  // The class is what drives the CSS fade-out; no class, no fade.
  it('applies the toastReplaced class when replaced is true', () => {
    const { container } = render(
      <MatchMoment match={match()} isBig={false} onDismiss={vi.fn()} replaced />,
    );
    // :not() picks the inner toast over its .toastSlot parent wrapper.
    const toast = container.querySelector('[class*="toast_"]:not([class*="toastSlot"])');
    expect(toast?.className).toMatch(/toastReplaced/);
  });

  // useEscape gates on isBig: only the big overlay answers Escape.
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
    // Confetti is a fixed 20 pieces.
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
    // Each Avatar is its own <svg>; scope to the row to exclude other icons.
    const avatarSvgs = container.querySelectorAll('[class*="avatarRow"] svg');
    expect(avatarSvgs.length).toBe(3);
  });

  it('falls back to a title-as-placeholder div when posterUrl is undefined', () => {
    const m = match();
    // biome-ignore lint/suspicious/noExplicitAny: in-test mutation to exercise the no-poster branch.
    (m.media as any).posterUrl = undefined;
    const { container } = render(<MatchMoment match={m} isBig={true} onDismiss={vi.fn()} />);
    expect(container.querySelector('img')).toBeNull();
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

  // The actions wrapper stopPropagation()s, so "Open in Plex" does not also
  // dismiss the overlay.
  it('clicking the overlay backdrop fires onDismiss', () => {
    const onDismiss = vi.fn();
    render(<MatchMoment match={match()} isBig={true} onDismiss={onDismiss} />);
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
