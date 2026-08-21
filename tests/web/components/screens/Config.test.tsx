// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConfigScreen } from '../../../../web/app/src/components/screens/Config';

// Shown when the server boots without a Plex provider. Deliberately has no
// inputs: credentials come from env vars only, since a browser-side setup form
// would open an unauthenticated-setup window.

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

  it('renders inside Layout (Logo wordmark visible)', () => {
    render(<ConfigScreen />);
    expect(screen.getByText('reely')).toBeDefined();
  });
});
