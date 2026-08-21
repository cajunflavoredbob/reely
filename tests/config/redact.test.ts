import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted: vi.mock factories are hoisted above plain top-level consts.
const { addRedactionMock } = vi.hoisted(() => ({ addRedactionMock: vi.fn() }));
vi.mock('../../internal/app/reely/logger', () => ({
  addRedaction: addRedactionMock,
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { registerRedactions } from '../../internal/app/reely/config/redact';
import type { Config } from '../../types/reely';

// Keeps the tests to the fields under test, without every unrelated one.
const cfg = (overrides: Partial<Config>): Partial<Config> => overrides;

describe('registerRedactions', () => {
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
      // The validator would reject this, but redact still has to tolerate it.
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
    // redact is called with the partial config even after the validator has
    // collected an error, so an off-type `servers` must not throw.
    registerRedactions({ servers: 'not-array' as unknown as Config['servers'] });
    expect(addRedactionMock).not.toHaveBeenCalled();
  });
});
