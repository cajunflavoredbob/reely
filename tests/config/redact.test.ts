import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted wraps the shared mock fn so vitest's hoist of vi.mock
// factories (which moves them above any plain top-level `const`) still
// sees a defined value. Logger surface mirrors the rest of the test
// suite; addRedaction is the only one this module touches.
const { addRedactionMock } = vi.hoisted(() => ({ addRedactionMock: vi.fn() }));
vi.mock('../../internal/app/reely/logger', () => ({
  addRedaction: addRedactionMock,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { registerRedactions } from '../../internal/app/reely/config/redact';
import type { Config } from '../../types/reely';

// Helper: build a minimal Partial<Config> with the fields under test.
// `as Partial<Config>` keeps the test focused on the redact contract
// without forcing every unrelated Config field.
const cfg = (overrides: Partial<Config>): Partial<Config> => overrides;

describe('registerRedactions (audit 12 #237 + #276)', () => {
  beforeEach(() => addRedactionMock.mockClear());

  it('registers server url + token', () => {
    registerRedactions(cfg({
      servers: [{ url: 'http://192.168.1.10:32400', token: 'tok' }],
    }));
    expect(addRedactionMock).toHaveBeenCalledWith('http://192.168.1.10:32400');
    expect(addRedactionMock).toHaveBeenCalledWith('tok');
  });

  it('registers basicAuth.password (new in 0.4.16)', () => {
    registerRedactions(cfg({
      servers: [],
      basicAuth: { userName: 'admin', password: 'secret' },
    }));
    expect(addRedactionMock).toHaveBeenCalledWith('secret');
  });

  it('skips a malformed url but still registers the token', () => {
    registerRedactions(cfg({
      // Cast: the validator would reject this; redact still has to
      // tolerate it (field-wise defense).
      servers: [{ url: 'not-a-url', token: 'tok' }] as Config['servers'],
    }));
    expect(addRedactionMock).not.toHaveBeenCalledWith('not-a-url');
    expect(addRedactionMock).toHaveBeenCalledWith('tok');
  });

  it('skips an empty token', () => {
    registerRedactions(cfg({
      servers: [{ url: 'http://h:1', token: '' }],
    }));
    expect(addRedactionMock).not.toHaveBeenCalledWith('');
  });

  it('skips an empty basicAuth password', () => {
    registerRedactions(cfg({
      basicAuth: { userName: 'admin', password: '' },
    }));
    expect(addRedactionMock).not.toHaveBeenCalledWith('');
  });

  it('no-ops when servers is missing or non-array', () => {
    registerRedactions(cfg({}));
    // Cast: a non-array `servers` is invalid per the type, but redact
    // must tolerate it (the validator may have collected an error
    // and we still get called with the partial config).
    registerRedactions({ servers: 'not-array' as unknown as Config['servers'] });
    expect(addRedactionMock).not.toHaveBeenCalled();
  });
});
