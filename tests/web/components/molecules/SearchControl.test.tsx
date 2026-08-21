// @vitest-environment jsdom
//
// biome-ignore-all lint/style/noNonNullAssertion: a missing element throws a TypeError, as actionable as an assertion failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SearchControl } from '../../../../web/app/src/components/molecules/SearchControl';

// Free-text tag input. Internal `q` state holds the input draft; no store.

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

  // Trim runs before the includes check, so padded duplicates are caught too.
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
    // The tag container carries searchTags; absent when values is empty.
    expect(container.querySelector('[class*="searchTags"]')).toBeNull();
  });

  it('clicking a tag\'s remove button fires onChange with that value filtered out', () => {
    const onChange = vi.fn();
    // Remove buttons are unlabeled (CloseIcon only), so query by class.
    const { container } = render(<SearchControl values={['drama', 'action', 'comedy']} placeholder="x" onChange={onChange} />);
    const removeBtns = container.querySelectorAll('[class*="searchTagRemove"]');
    // Second tag: "action".
    fireEvent.click(removeBtns[1]!);
    expect(onChange).toHaveBeenCalledWith(['drama', 'comedy']);
  });
});
