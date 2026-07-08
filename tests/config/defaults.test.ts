import { describe, expect, it } from 'vitest';
import { applyDefaults } from '../../internal/app/reely/config/defaults';

// Pure function: layers a defaults record over the partial input. The
// nested defaultServerConfig is merged into EACH item in `servers` (so
// every entry gets `type: 'plex'` unless it already has one).

describe('applyDefaults', () => {
  it('returns the full defaults when given an empty object', () => {
    expect(applyDefaults({})).toEqual({
      hostname: '0.0.0.0',
      port: 8000,
      logLevel: 'INFO',
      rootPath: '',
      servers: [],
      exposePlexBaseUrl: true,
    });
  });

  it('lets the input override individual default keys', () => {
    const out = applyDefaults({ port: 9000, hostname: '127.0.0.1' });
    expect(out.port).toBe(9000);
    expect(out.hostname).toBe('127.0.0.1');
    // Other defaults must still be present.
    expect(out.logLevel).toBe('INFO');
    expect(out.exposePlexBaseUrl).toBe(true);
  });

  it('layers defaultServerConfig (type: "plex") onto each server entry', () => {
    const out = applyDefaults({
      servers: [
        { url: 'http://plex-1', token: 'tok' },
        { url: 'http://plex-2', token: 'tok2' },
      ],
    });
    expect(out.servers).toEqual([
      { type: 'plex', url: 'http://plex-1', token: 'tok' },
      { type: 'plex', url: 'http://plex-2', token: 'tok2' },
    ]);
  });

  it('lets an explicit server.type override the default', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately off-spec server shape (no token, non-plex type) to prove the merge preserves an explicit type. Validator catches non-plex types elsewhere.
    const out = applyDefaults({ servers: [{ type: 'emby', url: 'http://x' } as any] });
    expect(out.servers?.[0]?.type).toBe('emby');
  });

  it('keeps `servers: []` as an empty array (the documented default)', () => {
    const out = applyDefaults({ servers: [] });
    expect(out.servers).toEqual([]);
  });

  // The `Array.isArray` guard means a non-array `servers` (e.g. a malformed
  // YAML scalar) doesn't crash the map call -- it just survives untouched
  // into the result, where the validator will catch it. Pin that behavior.
  it('does not throw when servers is not an array', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately off-spec input to exercise the Array.isArray guard.
    expect(() => applyDefaults({ servers: 'oops' as any })).not.toThrow();
  });

  it('does not mutate the input object', () => {
    const input = { port: 9000 };
    const before = JSON.stringify(input);
    applyDefaults(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
