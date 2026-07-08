// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConfigScreen } from '../../../../web/app/src/components/screens/Config';

// ConfigScreen is shown when the server boots without a Plex provider.
// Deliberately has no inputs (Plex credentials come from env vars only;
// audit 12 #198 -- a browser-side setup form would re-introduce the
// unauthenticated-setup window that 0.3.4 closed). Pure presentation
// wrapped in Layout.

afterEach(() => {
  cleanup();
});

describe('ConfigScreen', () => {
  it('renders the "not set up" heading', () => {
    render(<ConfigScreen />);
    expect(screen.getByRole('heading', { name: /isn't set up yet/i })).toBeDefined();
  });

  it('renders the explanatory body text', () => {
    render(<ConfigScreen />);
    expect(screen.getByText(/Check back once it's ready/)).toBeDefined();
  });

  // Layout includes the brand Logo by default; ConfigScreen doesn't pass
  // hideLogo so the wordmark should be visible.
  it('renders inside Layout (Logo wordmark visible)', () => {
    render(<ConfigScreen />);
    expect(screen.getByText('reely')).toBeDefined();
  });
});
