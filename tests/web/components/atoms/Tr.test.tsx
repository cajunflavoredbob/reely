// @vitest-environment jsdom
//
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the literal `${...}` strings are the fixtures Tr resolves.
// biome-ignore-all lint/suspicious/noExplicitAny: lets each render use an arbitrary key without threading TranslationKey through.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// Tr only reads `useStore(['translations'])`, so the mock returns a
// controllable map plus a no-op dispatch to satisfy the destructure.
// vi.hoisted lifts the fn so vi.mock's hoisted factory can reference it
// without TDZ.
const { useStoreMock } = vi.hoisted(() => ({
  useStoreMock: vi.fn(),
}));

vi.mock('../../../../web/app/src/store', () => ({
  useStore: useStoreMock,
  // Unused by Tr, but the mocked module surface has to match the real one:
  // an export missing here is `undefined` at any call site that reaches it.
  useDispatch: vi.fn(),
  useSelector: vi.fn(),
  useStoreComputed: vi.fn(),
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

  it('falls back to the name itself when no translation is registered', () => {
    const { container } = render(<Tr name={'MISSING_KEY' as any} />);
    expect(container.textContent).toBe('MISSING_KEY');
  });

  it('interpolates ${key} placeholders from context', () => {
    withTranslations({ GREETING: 'Hello ${name}!' });
    const { container } = render(<Tr name={'GREETING' as any} context={{ name: 'alice' }} />);
    expect(container.textContent).toBe('Hello alice!');
  });

  // Guards against rendering the string "undefined": interpolate's function
  // replacer falls back with `?? full`.
  it('leaves the ${key} placeholder visible when the context key is missing', () => {
    withTranslations({ GREETING: 'Hello ${name}!' });
    const { container } = render(<Tr name={'GREETING' as any} context={{}} />);
    expect(container.textContent).toBe('Hello ${name}!');
  });

  // The function-replacer form opts out of String.replace's $& / $1
  // back-references, so a value containing "$&" is not re-expanded.
  it('does not expand $& back-references in interpolated values', () => {
    withTranslations({ MONEY: 'Price is ${price}' });
    const { container } = render(<Tr name={'MONEY' as any} context={{ price: '$5 or $&' }} />);
    expect(container.textContent).toBe('Price is $5 or $&');
  });

  // Dotted paths match the server-side template regex but are looked up flat;
  // the frontend does not walk nested objects.
  it('accepts dotted ${user.name} placeholders and looks them up flat', () => {
    withTranslations({ HI: 'Hi ${user.name}!' });
    const { container } = render(<Tr name={'HI' as any} context={{ 'user.name': 'alice' }} />);
    expect(container.textContent).toBe('Hi alice!');
  });

  // interpolate runs only when translation and context are both truthy, so
  // placeholders stay literal.
  it('renders the raw translation untouched when no context is provided', () => {
    withTranslations({ RAW: 'Has ${unresolved}' });
    const { container } = render(<Tr name={'RAW' as any} />);
    expect(container.textContent).toBe('Has ${unresolved}');
  });
});
