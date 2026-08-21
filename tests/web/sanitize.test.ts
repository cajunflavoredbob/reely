import { describe, it, expect } from 'vitest';
import {
  sanitizeUserInput,
  sanitizeRoomNameDisplay,
} from '../../web/app/src/utils/sanitize';

// The optional maxLength parameter keeps the bound even if the JSX maxLength
// attribute ever drops out.

describe('sanitizeUserInput', () => {
  it('strips control / null bytes and path-traversal characters', () => {
    expect(sanitizeUserInput('foo\x00..\\bar/baz')).toBe('foobarbaz');
  });

  it('returns the cleaned string unchanged when no maxLength is passed', () => {
    expect(sanitizeUserInput('a'.repeat(200))).toHaveLength(200);
  });

  it('caps the cleaned string at maxLength when provided', () => {
    expect(sanitizeUserInput('a'.repeat(200), 64)).toHaveLength(64);
  });

  it('caps AFTER stripping, so the cap reflects the visible length', () => {
    // '..abcdef' -> 'abcdef' -> cap 4 -> 'abcd'.
    expect(sanitizeUserInput('..abcdef', 4)).toBe('abcd');
  });
});

describe('sanitizeRoomNameDisplay', () => {
  it('strips disallowed characters and preserves the rest', () => {
    expect(sanitizeRoomNameDisplay("Bob's Pizza!")).toBe("Bob's Pizza!");
    expect(sanitizeRoomNameDisplay('foo/bar*baz')).toBe('foobarbaz');
  });

  it('caps the cleaned string at maxLength when provided', () => {
    expect(sanitizeRoomNameDisplay('a'.repeat(200), 48)).toHaveLength(48);
  });
});

// A single strip pass can reconstruct '..' out of the surviving characters.
// Mirrors the server-side coverage in tests/util/sanitize.test.ts.
describe('sanitizeUserInput strip idempotency', () => {
  it.each([
    ['./.', ''],
    ['.\x00.', ''],
    ['.\.', ''],
    ['a./.b', 'ab'],
  ])('sanitizeUserInput(%j) contains no ".." (-> %j)', (input, expected) => {
    const out = sanitizeUserInput(input);
    expect(out).not.toContain('..');
    expect(out).toBe(expected);
  });
});
