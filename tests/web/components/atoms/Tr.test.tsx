// @vitest-environment jsdom
//
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file's literal `${...}` strings ARE the test fixtures -- they're interpolation placeholders that Tr resolves, not unintended template literals.
// biome-ignore-all lint/suspicious/noExplicitAny: TranslationKey union isn't worth threading through every test render's `name=` prop; `as any` casts let each test use an arbitrary string key without polluting the production type.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// Mock the Zustand store entry. Tr only uses `useStore(['translations'])`,
// so the mock returns a controllable `translations` map. The dispatch slot
// is a no-op fn -- nothing in Tr touches it but the return shape is
// `[store, dispatch]` so the destructure has to land.
//
// vi.hoisted lifts the mock fn so vi.mock's hoisted factory can reference
// it without TDZ (same pattern as the load_secrets mock in
// tests/config/load_env.test.ts and several earlier batches).
const { useStoreMock } = vi.hoisted(() => ({
  useStoreMock: vi.fn(),
}));

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  // Keep the other exports present so an accidental import from elsewhere
  // doesn't fall off; they're not used by Tr but the module surface needs
  // to match what `'../../store'` would resolve to in production.
  useDispatch: vi.fn(),
  useSelector: vi.fn(),
  createStore: vi.fn(),
}));

import { Tr } from '../../../../web/app/src/components/atoms/Tr';

const withTranslations = (translations: any) => {
  useStoreMock.mockReturnValue([{ translations }, vi.fn()]);
};

beforeEach(() => {
  useStoreMock.mockReset();
  withTranslations({});
});

afterEach(() => {
  cleanup();
});

describe('Tr', () => {
  it('renders the translation for a known name', () => {
    withTranslations({ FILTERS_LOADING: 'Loading filters' });
    const { container } = render(<Tr name={'FILTERS_LOADING' as any} />);
    expect(container.textContent).toBe('Loading filters');
  });

  // Missing key: fall back to the name itself rather than "undefined".
  // (`{translation ?? name}` in the source.)
  it('falls back to the name itself when no translation is registered', () => {
    const { container } = render(<Tr name={'MISSING_KEY' as any} />);
    expect(container.textContent).toBe('MISSING_KEY');
  });

  it('interpolates ${key} placeholders from context', () => {
    withTranslations({ GREETING: 'Hello ${name}!' });
    const { container } = render(<Tr name={'GREETING' as any} context={{ name: 'alice' }} />);
    expect(container.textContent).toBe('Hello alice!');
  });

  // Missing context key leaves the literal `${name}` visible rather than
  // substituting the string "undefined". The single-pass function-replacer
  // form in interpolate makes this `?? full` fallback work.
  it('leaves the ${key} placeholder visible when the context key is missing', () => {
    withTranslations({ GREETING: 'Hello ${name}!' });
    const { container } = render(<Tr name={'GREETING' as any} context={{}} />);
    expect(container.textContent).toBe('Hello ${name}!');
  });

  // Function-replacer form opts out of String.replace's $& / $1 back-
  // reference interpretation. A translation that happens to contain "$&"
  // must not be re-expanded to the matched substring.
  it('does not expand $& back-references in interpolated values', () => {
    withTranslations({ MONEY: 'Price is ${price}' });
    const { container } = render(<Tr name={'MONEY' as any} context={{ price: '$5 or $&' }} />);
    expect(container.textContent).toBe('Price is $5 or $&');
  });

  // Dotted-path placeholders are accepted (matches the server-side template
  // regex) but looked up flat in context -- the frontend doesn't walk
  // nested objects.
  it('accepts dotted ${user.name} placeholders and looks them up flat', () => {
    withTranslations({ HI: 'Hi ${user.name}!' });
    const { container } = render(<Tr name={'HI' as any} context={{ 'user.name': 'alice' }} />);
    expect(container.textContent).toBe('Hi alice!');
  });

  // Translation present but no context provided: render the raw translation,
  // including any unresolved ${name} placeholders. (The interpolate branch
  // only runs when both translation AND context are truthy.)
  it('renders the raw translation untouched when no context is provided', () => {
    withTranslations({ RAW: 'Has ${unresolved}' });
    const { container } = render(<Tr name={'RAW' as any} />);
    expect(container.textContent).toBe('Has ${unresolved}');
  });
});
