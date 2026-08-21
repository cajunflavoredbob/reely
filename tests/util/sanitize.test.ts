import { describe, it, expect } from 'vitest';
import {
  sanitizeInput,
  sanitizeRoomNameCanonical,
  sanitizeRoomNameDisplay,
} from '../../internal/app/reely/util/sanitize';

describe('sanitizeInput', () => {
  it('passes clean strings through unchanged', () => {
    expect(sanitizeInput('hello')).toBe('hello');
    expect(sanitizeInput('My Room 123')).toBe('My Room 123');
    expect(sanitizeInput('movie-night_2')).toBe('movie-night_2');
  });

  it('strips forward and back slashes', () => {
    expect(sanitizeInput('foo/bar')).toBe('foobar');
    expect(sanitizeInput('foo\\bar')).toBe('foobar');
    expect(sanitizeInput('a/b\\c')).toBe('abc');
  });

  it('strips path traversal sequences', () => {
    expect(sanitizeInput('../..')).toBe('');
    expect(sanitizeInput('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeInput('foo/../bar')).toBe('foobar');
    expect(sanitizeInput('....//secret')).toBe('secret');
  });

  it('strips null bytes', () => {
    expect(sanitizeInput('foo\x00bar')).toBe('foobar');
    expect(sanitizeInput('\x00')).toBe('');
  });

  it('strips control characters', () => {
    expect(sanitizeInput('foo\x01bar')).toBe('foobar');
    expect(sanitizeInput('foo\x1fbar')).toBe('foobar');
    expect(sanitizeInput('foo\x7fbar')).toBe('foobar');
    expect(sanitizeInput('\t\ntest\r')).toBe('test'); // tabs and newlines are control chars
  });

  // Bidi overrides and isolates reverse rendering direction, so a username
  // can display as "alice" and store as something else.
  it('strips Unicode bidi-override and isolate characters', () => {
    expect(sanitizeInput('alice\u{202E}eve')).toBe('aliceeve');           // RLO
    expect(sanitizeInput('\u{202A}lefttoright')).toBe('lefttoright');     // LRE
    expect(sanitizeInput('\u{202B}righttoleft')).toBe('righttoleft');     // RLE
    expect(sanitizeInput('\u{202C}pop')).toBe('pop');                     // PDF
    expect(sanitizeInput('\u{202D}override')).toBe('override');           // LRO
    expect(sanitizeInput('alice\u{2066}isolate')).toBe('aliceisolate');   // LRI
    expect(sanitizeInput('\u{2067}\u{2068}\u{2069}name')).toBe('name');   // RLI + FSI + PDI
  });

  // Zero-width characters and BOMs let a name render identically and compare
  // unequal: the impersonation vector.
  it('strips zero-width characters and BOM', () => {
    expect(sanitizeInput('alice\u{200B}extra')).toBe('aliceextra');       // ZWSP
    expect(sanitizeInput('alice\u{200C}')).toBe('alice');                  // ZWNJ
    expect(sanitizeInput('alice\u{200D}extra')).toBe('aliceextra');       // ZWJ
    expect(sanitizeInput('alice\u{2060}extra')).toBe('aliceextra');       // word joiner
    expect(sanitizeInput('\u{FEFF}alice')).toBe('alice');                  // BOM
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeInput('  hello  ')).toBe('hello');
    expect(sanitizeInput('  ')).toBe('');
  });

  it('enforces default maxLength of 64', () => {
    expect(sanitizeInput('a'.repeat(100))).toBe('a'.repeat(64));
    expect(sanitizeInput('a'.repeat(64))).toBe('a'.repeat(64));
    expect(sanitizeInput('a'.repeat(63))).toBe('a'.repeat(63));
  });

  it('enforces a custom maxLength', () => {
    expect(sanitizeInput('abcdef', 3)).toBe('abc');
    expect(sanitizeInput('ab', 3)).toBe('ab');
  });

  it('applies maxLength after stripping, not before', () => {
    // '..abc' strips to 'abc', then slices to 'ab'.
    expect(sanitizeInput('..abc', 2)).toBe('ab');
  });

  it('returns empty string for input composed entirely of stripped characters', () => {
    expect(sanitizeInput('../../../')).toBe('');
    expect(sanitizeInput('/\\\x00\x1f')).toBe('');
  });
});

describe('sanitizeRoomNameDisplay', () => {
  it('preserves case', () => {
    expect(sanitizeRoomNameDisplay('Movie Night')).toBe('Movie Night');
    expect(sanitizeRoomNameDisplay("Bob's Pizza")).toBe("Bob's Pizza");
  });

  it('keeps the allowlisted punctuation set', () => {
    expect(sanitizeRoomNameDisplay("!@$-_'")).toBe("!@$-_'");
  });

  it("strips disallowed characters (# ? \" and friends)", () => {
    expect(sanitizeRoomNameDisplay('What#room')).toBe('Whatroom');
    expect(sanitizeRoomNameDisplay('hi?')).toBe('hi');
    expect(sanitizeRoomNameDisplay('say "hi"')).toBe('say hi');
    expect(sanitizeRoomNameDisplay('a&b')).toBe('ab');
    expect(sanitizeRoomNameDisplay('a.b')).toBe('ab');
    expect(sanitizeRoomNameDisplay('a,b')).toBe('ab');
  });

  it('strips control bytes and path-traversal-flavored characters', () => {
    expect(sanitizeRoomNameDisplay('foo\x00bar')).toBe('foobar');
    expect(sanitizeRoomNameDisplay('foo/bar')).toBe('foobar');
    expect(sanitizeRoomNameDisplay('foo\\bar')).toBe('foobar');
  });

  it('collapses internal whitespace runs and trims edges', () => {
    expect(sanitizeRoomNameDisplay('  movie   night  ')).toBe('movie night');
  });

  it('strips tabs / newlines entirely (not in allowlist)', () => {
    // The allowlist takes the space character only, so adjacent tabs vanish
    // rather than collapsing to one space.
    expect(sanitizeRoomNameDisplay('a\t\tb')).toBe('ab');
    expect(sanitizeRoomNameDisplay('foo\nbar')).toBe('foobar');
  });

  it('caps at 48 chars', () => {
    expect(sanitizeRoomNameDisplay('a'.repeat(100))).toBe('a'.repeat(48));
  });

  it('returns empty for entirely-invalid input', () => {
    expect(sanitizeRoomNameDisplay('###???"""')).toBe('');
  });
});

describe('sanitizeRoomNameCanonical', () => {
  it('lowercases the display form', () => {
    expect(sanitizeRoomNameCanonical('Movie Night')).toBe('movie night');
    expect(sanitizeRoomNameCanonical('SHOUTING')).toBe('shouting');
  });

  it('mirrors the display sanitizer otherwise', () => {
    expect(sanitizeRoomNameCanonical("Bob's Pizza!")).toBe("bob's pizza!");
    expect(sanitizeRoomNameCanonical('What#Up?')).toBe('whatup');
    expect(sanitizeRoomNameCanonical('foo/bar')).toBe('foobar');
  });

  it('is idempotent', () => {
    const out = sanitizeRoomNameCanonical("Movie Night's Best!");
    expect(sanitizeRoomNameCanonical(out)).toBe(out);
  });

  it('returns empty for entirely-invalid input', () => {
    expect(sanitizeRoomNameCanonical('###?')).toBe('');
  });
});

// A single pass is not idempotent: removing a stripped character sitting
// between two dots reconstructs the '..' the pattern exists to remove. The
// strip has to run to a fixpoint.
describe('sanitizeInput strip idempotency', () => {
  it.each([
    ['./.', ''],
    ['.\x00.', ''],
    ['.\.', ''],
    ['a./.b', 'ab'],
    ['a.​.b', 'ab'], // zero-width space between dots
    ['....//secret', 'secret'],
  ])('sanitizeInput(%j) contains no ".." (-> %j)', (input, expected) => {
    const out = sanitizeInput(input);
    expect(out).not.toContain('..');
    expect(out).toBe(expected);
  });
});
