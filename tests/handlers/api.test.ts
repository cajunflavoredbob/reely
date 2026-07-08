import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage } from 'node:http';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

vi.mock('../../internal/app/reely/config/main', () => ({
  getConfig: vi.fn(),
}));

import { isOriginAllowed } from '../../internal/app/reely/handlers/api';
import { getConfig } from '../../internal/app/reely/config/main';

const mockedGetConfig = vi.mocked(getConfig);

// Minimal IncomingMessage stub: only headers are read.
const req = (headers: Record<string, string>): IncomingMessage =>
  ({ headers } as unknown as IncomingMessage);

describe('isOriginAllowed (CSWSH guard)', () => {
  beforeEach(() => {
    // Explicit reset (audit 12 #247): the vitest.config.ts `clearMocks`
    // toggle (0.4.13) covers call history but NOT the mockReturnValue
    // set by a prior test. Without `mockReset`, a test that overrode
    // `mockReturnValue({ allowedOrigins: ['...'] })` left that value
    // visible to the next test. Belt-and-suspenders alongside the
    // global clearMocks/restoreMocks.
    mockedGetConfig.mockReset();
    mockedGetConfig.mockReturnValue({ allowedOrigins: [] } as never);
  });

  it('allows a request with no Origin header (non-browser client)', () => {
    expect(isOriginAllowed(req({ host: 'reely.lan:8000' }))).toBe(true);
  });

  it('allows a same-origin request (Origin host matches Host)', () => {
    expect(
      isOriginAllowed(req({ host: 'reely.lan:8000', origin: 'http://reely.lan:8000' })),
    ).toBe(true);
  });

  it('rejects a cross-origin request not on the allowlist', () => {
    expect(
      isOriginAllowed(req({ host: 'reely.lan:8000', origin: 'http://evil.example.com' })),
    ).toBe(false);
  });

  it('allows a cross-origin request whose Origin is in allowedOrigins', () => {
    mockedGetConfig.mockReturnValue(
      { allowedOrigins: ['https://reely.example.com'] } as never,
    );
    expect(
      isOriginAllowed(
        req({ host: 'internal:8000', origin: 'https://reely.example.com' }),
      ),
    ).toBe(true);
  });

  it('rejects a malformed Origin header', () => {
    expect(
      isOriginAllowed(req({ host: 'reely.lan:8000', origin: 'not a url' })),
    ).toBe(false);
  });
});
