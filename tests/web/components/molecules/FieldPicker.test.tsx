// @vitest-environment jsdom
//
// biome-ignore-all lint/style/noNonNullAssertion: a missing ancestor throws a TypeError, as actionable as an assertion failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FieldPicker } from '../../../../web/app/src/components/molecules/FieldPicker';
import type { Filters } from '../../../../types/reely';

// Searchable list of available filter fields. Pure presentation: no state, no
// store, no timers. FilterPanel owns the open flag and the search term.

type FieldDef = Filters['filters'][number];

const fields: FieldDef[] = [
  { key: 'year', title: 'Year', type: 'integer' },
  { key: 'genre', title: 'Genre', type: 'string' },
  { key: 'rating', title: 'Rating', type: 'string' },
];

afterEach(() => {
  cleanup();
});

describe('FieldPicker', () => {
  it('renders the search input and Cancel button', () => {
    render(
      <FieldPicker
        availableFields={fields}
        search=""
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText('Search fields…')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
  });

  it('reflects the search prop as the input value', () => {
    render(
      <FieldPicker
        availableFields={fields}
        search="gen"
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect((screen.getByPlaceholderText('Search fields…') as HTMLInputElement).value).toBe('gen');
  });

  it('fires onSearchChange when the user types', () => {
    const onSearchChange = vi.fn();
    render(
      <FieldPicker
        availableFields={fields}
        search=""
        onSearchChange={onSearchChange}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('Search fields…'), {
      target: { value: 'g' },
    });
    expect(onSearchChange).toHaveBeenCalledWith('g');
  });

  it('Cancel button fires onClose', () => {
    const onClose = vi.fn();
    render(
      <FieldPicker
        availableFields={fields}
        search=""
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders one button per available field with its title + type', () => {
    render(
      <FieldPicker
        availableFields={fields}
        search=""
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('Year')).toBeDefined();
    expect(screen.getByText('integer')).toBeDefined();
    expect(screen.getByText('Genre')).toBeDefined();
    expect(screen.getByText('Rating')).toBeDefined();
  });

  it('clicking a field button fires onSelect with that field\'s key', () => {
    const onSelect = vi.fn();
    render(
      <FieldPicker
        availableFields={fields}
        search=""
        onSearchChange={vi.fn()}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Genre').closest('button')!);
    expect(onSelect).toHaveBeenCalledWith('genre');
  });

  it('renders the "No more fields." empty state when availableFields is empty', () => {
    render(
      <FieldPicker
        availableFields={[]}
        search=""
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('No more fields.')).toBeDefined();
  });

  it('renders the first letter of the title in the picker-item icon', () => {
    // Icon span holds title.charAt(0).
    const { container } = render(
      <FieldPicker
        availableFields={[{ key: 'year', title: 'Year', type: 'integer' }]}
        search=""
        onSearchChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const icon = container.querySelector('[class*="pickerItemIcon"]');
    expect(icon?.textContent).toBe('Y');
  });
});
