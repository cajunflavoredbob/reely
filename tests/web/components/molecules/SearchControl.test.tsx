// @vitest-environment jsdom
//
// biome-ignore-all lint/style/noNonNullAssertion: indexing into SUT-rendered queryAll results; a missing element would surface a TypeError that's no less actionable than a Vitest assertion failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SearchControl } from '../../../../web/app/src/components/molecules/SearchControl';

// SearchControl is the free-text tag input extracted from FilterPanel
// in 0.4.47 (audit 13 #321 split, Option B). Pure presentation +
// internal `q` state for the input draft. No store, no timers.

afterEach(() => {
  cleanup();
});

describe('SearchControl', () => {
  it('renders the input with the supplied placeholder', () => {
    render(<SearchControl values={[]} placeholder="Add a value…" onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText('Add a value…')).toBeDefined();
  });

  it('disables the Apply button when the input is empty', () => {
    render(<SearchControl values={[]} placeholder="x" onChange={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables the Apply button once the input has non-whitespace text', () => {
    render(<SearchControl values={[]} placeholder="x" onChange={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('x'), { target: { value: 'one' } });
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('fires onChange with the appended (trimmed) value when Apply is clicked', () => {
    const onChange = vi.fn();
    render(<SearchControl values={['existing']} placeholder="x" onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('x'), { target: { value: '  new  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).toHaveBeenCalledWith(['existing', 'new']);
  });

  it('Enter key submits the value just like clicking Apply', () => {
    const onChange = vi.fn();
    render(<SearchControl values={[]} placeholder="x" onChange={onChange} />);
    const input = screen.getByPlaceholderText('x');
    fireEvent.change(input, { target: { value: 'enter-value' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['enter-value']);
  });

  // Don't double-add a value that's already in the tags. Applies even
  // with leading/trailing whitespace -- the trim happens before the
  // includes check.
  it('does NOT add a duplicate value (compare after trim)', () => {
    const onChange = vi.fn();
    render(<SearchControl values={['drama']} placeholder="x" onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('x'), { target: { value: '  drama  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears the input after a submit (whether the value was added or duplicate)', () => {
    render(<SearchControl values={[]} placeholder="x" onChange={vi.fn()} />);
    const input = screen.getByPlaceholderText('x') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(input.value).toBe('');
  });

  it('does NOT submit when the input is whitespace-only', () => {
    const onChange = vi.fn();
    render(<SearchControl values={[]} placeholder="x" onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText('x'), { target: { value: '   ' } });
    // Apply stays disabled.
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true);
    // Enter also no-ops.
    fireEvent.keyDown(screen.getByPlaceholderText('x'), { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders the tag list when values is non-empty', () => {
    render(<SearchControl values={['drama', 'action']} placeholder="x" onChange={vi.fn()} />);
    expect(screen.getByText('drama')).toBeDefined();
    expect(screen.getByText('action')).toBeDefined();
  });

  it('omits the tag list when values is empty', () => {
    const { container } = render(<SearchControl values={[]} placeholder="x" onChange={vi.fn()} />);
    // searchTags class is applied to the tag container; absent when values=[]
    expect(container.querySelector('[class*="searchTags"]')).toBeNull();
  });

  // Tag-remove buttons fire onChange with the value filtered out.
  it('clicking a tag\'s remove button fires onChange with that value filtered out', () => {
    const onChange = vi.fn();
    render(<SearchControl values={['drama', 'action', 'comedy']} placeholder="x" onChange={onChange} />);
    // Each tag-remove button is unlabeled (just the CloseIcon); find
    // the buttons inside the tag list.
    const { container } = render(<SearchControl values={['drama', 'action', 'comedy']} placeholder="x" onChange={onChange} />);
    const removeBtns = container.querySelectorAll('[class*="searchTagRemove"]');
    // Click the second tag's remove button ("action").
    fireEvent.click(removeBtns[1]!);
    expect(onChange).toHaveBeenCalledWith(['drama', 'comedy']);
  });
});
