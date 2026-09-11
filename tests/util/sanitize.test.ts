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

  // Format characters are invisible by definition, so any one of them left
  // unstripped is another way to mint a room member whose pill, tooltip and
  // avatar initial are indistinguishable from an existing member's.
  it('strips bidi marks, the soft hyphen and the Mongolian vowel separator', () => {
    expect(sanitizeInput('alice\u{200E}extra')).toBe('aliceextra');   // LRM
    expect(sanitizeInput('alice\u{200F}extra')).toBe('aliceextra');   // RLM
    expect(sanitizeInput('alice\u{061C}extra')).toBe('aliceextra');   // ALM
    expect(sanitizeInput('alice\u{00AD}extra')).toBe('aliceextra');   // soft hyphen
    expect(sanitizeInput('alice\u{180E}extra')).toBe('aliceextra');   // MVS
  });

  // Not format characters: the Hangul fillers are ordinary letters and the
  // braille blank is a symbol. Both render as nothing.
  it('strips the invisible Hangul fillers and the braille blank', () => {
    expect(sanitizeInput('alice\u{3164}')).toBe('alice');
    expect(sanitizeInput('alice\u{115F}')).toBe('alice');
    expect(sanitizeInput('alice\u{1160}')).toBe('alice');
    expect(sanitizeInput('alice\u{FFA0}')).toBe('alice');
    expect(sanitizeInput('alice\u{2800}')).toBe('alice');
  });

  it('leaves ordinary letters from other scripts alone', () => {
    expect(sanitizeInput('Ренэ')).toBe('Ренэ');
    expect(sanitizeInput('映画')).toBe('映画');
    expect(sanitizeInput('Zoë')).toBe('Zoë');
  });

  // Two members whose names render identically but compare unequal can match
  // with each other and are impossible to tell apart in the users popup.
  it('folds a decomposed name onto its precomposed form', () => {
    const precomposed: string = 'José';
    const decomposed: string = 'Jose\u{0301}';
    expect(precomposed).not.toBe(decomposed); // the raw strings differ
    expect(sanitizeInput(decomposed)).toBe(sanitizeInput(precomposed));
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

  // Trimming before the slice lets the truncation put back the whitespace the
  // trim removed, so the result renders identically to the shorter name while
  // being a distinct key in room.users, ratings, userProgress and userRated.
  it('does not return a value ending in whitespace when it truncates', () => {
    const crafted = `${'a'.repeat(63)} b`;
    expect(sanitizeInput(crafted)).toBe('a'.repeat(63));
  });

  it.each([
    `${'a'.repeat(63)} b`,
    `${'a'.repeat(70)}   `,
    `  ${'a'.repeat(80)}`,
    '  spaced  out  ',
  ])('is a fixpoint: sanitizeInput(sanitizeInput(%j)) is unchanged', (input) => {
    const once = sanitizeInput(input);
    expect(sanitizeInput(once)).toBe(once);
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

  // An ASCII-only allowlist deleted every accented and non-Latin letter, so the
  // five non-English locales this app ships watched each character they typed
  // disappear from the field with no error and no hint.
  it('keeps letters from the locales the app ships', () => {
    expect(sanitizeRoomNameDisplay('Filmabend für Zwei')).toBe('Filmabend für Zwei');
    expect(sanitizeRoomNameDisplay('Wieczór filmowy')).toBe('Wieczór filmowy');
    expect(sanitizeRoomNameDisplay('Soirée ciné')).toBe('Soirée ciné');
    expect(sanitizeRoomNameDisplay('Película')).toBe('Película');
    expect(sanitizeRoomNameDisplay('Filmavond')).toBe('Filmavond');
  });

  it('keeps non-Latin scripts instead of emptying the field', () => {
    expect(sanitizeRoomNameDisplay('映画の夜')).toBe('映画の夜');
    expect(sanitizeRoomNameDisplay('Кино вечер')).toBe('Кино вечер');
  });

  // The room name is the filename; a letter that renders as blank would make a
  // second room indistinguishable from the first.
  it('still strips invisible letters and format characters', () => {
    expect(sanitizeRoomNameDisplay('movie\u{3164} night')).toBe('movie night');
    expect(sanitizeRoomNameDisplay('movie\u{200B}night')).toBe('movienight');
    expect(sanitizeRoomNameDisplay('movie\u{200E}night')).toBe('movienight');
  });

  it('does not return a value ending in whitespace when it truncates', () => {
    expect(sanitizeRoomNameDisplay(`${'a'.repeat(47)} b`)).toBe('a'.repeat(47));
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

  // The canonical name is the registry key AND the filename, so two spellings
  // of one visible string mean two rooms that never see each other, each
  // reporting "0 others swiping".
  it('maps the decomposed and precomposed spellings onto one room', () => {
    const nfc: string = 'Café Night';
    const nfd = nfc.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    expect(sanitizeRoomNameCanonical(nfd)).toBe(sanitizeRoomNameCanonical(nfc));
  });

  // Folding accents away instead of normalizing would merge these, so a name
  // someone typed with an accent would collide with the plain spelling.
  it('keeps an accented name distinct from its unaccented spelling', () => {
    expect(sanitizeRoomNameCanonical('Café Night')).not.toBe(
      sanitizeRoomNameCanonical('Cafe Night'),
    );
  });

  it('lowercases non-Latin and accented names without emptying them', () => {
    expect(sanitizeRoomNameCanonical('Película')).toBe('película');
    expect(sanitizeRoomNameCanonical('映画の夜')).toBe('映画の夜');
  });

  it('is a fixpoint for a truncated name', () => {
    const once = sanitizeRoomNameCanonical(`${'a'.repeat(47)} b`);
    expect(sanitizeRoomNameCanonical(once)).toBe(once);
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
