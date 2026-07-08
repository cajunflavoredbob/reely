// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ErrorMessage } from '../../../../web/app/src/components/atoms/ErrorMessage';

afterEach(() => {
  cleanup();
});

describe('ErrorMessage', () => {
  it('renders the message text in a <p>', () => {
    const { container } = render(<ErrorMessage message="boom" />);
    expect(screen.getByText('boom')).toBeDefined();
    expect(container.querySelector('p')).not.toBeNull();
  });

  it('renders empty content cleanly when message is an empty string', () => {
    const { container } = render(<ErrorMessage message="" />);
    const p = container.querySelector('p');
    expect(p).not.toBeNull();
    expect(p?.textContent).toBe('');
  });
});
