import { describe, it, expect } from 'vitest';
import {
  sanitizeUserInput,
  sanitizeRoomNameDisplay,
} from '../../web/app/src/utils/sanitize';

// Audit 9 #104: the prior implementation relied solely on the input
// element's maxLength attribute to bound length. 0.4.3 added an optional
// maxLength function parameter so the bound holds even if the JSX
// maxLength ever drops out.

describe('sanitizeUserInput', () => {
  it('strips control / null bytes and path-traversal characters', () => {
    expect(sanitizeUserInput('foo\x00..\\bar/baz')).toBe('foobarbaz');
  });

  it('returns the cleaned string unchanged when no maxLength is passed', () => {
    expect(sanitizeUserInput('a'.repeat(200))).toHaveLength(200);
  });

  it('caps the cleaned string at maxLength when provided (audit 9 #104)', () => {
    expect(sanitizeUserInput('a'.repeat(200), 64)).toHaveLength(64);
  });

  it('caps AFTER stripping, so the cap reflects the visible length', () => {
    // '..abcdef' -> strip '..' -> 'abcdef'; cap 4 -> 'abcd'
    expect(sanitizeUserInput('..abcdef', 4)).toBe('abcd');
  });
});

describe('sanitizeRoomNameDisplay', () => {
  it('strips disallowed characters and preserves the rest', () => {
    expect(sanitizeRoomNameDisplay("Bob's Pizza!")).toBe("Bob's Pizza!");
    expect(sanitizeRoomNameDisplay('foo/bar*baz')).toBe('foobarbaz');
  });

  it('caps the cleaned string at maxLength when provided (audit 9 #104)', () => {
    expect(sanitizeRoomNameDisplay('a'.repeat(200), 48)).toHaveLength(48);
  });
});

// Audit 16 #440: same fixpoint-strip regression coverage as the server
// wrapper (tests/util/sanitize.test.ts) -- both sides strip through the
// shared stripDangerous helper and must not reconstruct '..'.
describe('sanitizeUserInput strip idempotency (audit 16 #440)', () => {
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
