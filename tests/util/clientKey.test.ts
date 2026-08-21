import { describe, it, expect } from 'vitest';
import { clientKey } from '../../internal/app/reely/util/clientKey';

// The WS slot limit, the Basic Auth failure throttle and the HTTP rate
// limiter all key on this. Raw IPv6 made every cap per-connection rather
// than per-client.
describe('clientKey', () => {
  it('passes IPv4 through unchanged', () => {
    expect(clientKey('203.0.113.5')).toBe('203.0.113.5');
  });

  it('treats an IPv4-mapped address as the IPv4 client', () => {
    // One bucket per host, however the socket reports it.
    expect(clientKey('::ffff:203.0.113.5')).toBe(clientKey('203.0.113.5'));
  });

  it('groups every address in a /64 into one key', () => {
    // One subscriber gets a whole /64 and privacy extensions rotate through
    // it. Per-address buckets left the 20-socket cap bounding nothing.
    const a = clientKey('2001:db8:1234:5678:aaaa:bbbb:cccc:dddd');
    const b = clientKey('2001:db8:1234:5678:1111:2222:3333:4444');
    const c = clientKey('2001:db8:1234:5678::1');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('keeps different /64s apart', () => {
    expect(clientKey('2001:db8:1234:5678::1')).not.toBe(
      clientKey('2001:db8:1234:9999::1'),
    );
  });

  it('normalises leading zeroes and case', () => {
    expect(clientKey('2001:0DB8:0000:0001::1')).toBe(clientKey('2001:db8:0:1::1'));
  });

  it('ignores a zone index', () => {
    expect(clientKey('fe80::1%eth0')).toBe(clientKey('fe80::1'));
  });

  it('falls back to the literal for an unparseable address', () => {
    // One shared bucket beats throwing on the upgrade path.
    expect(clientKey('2001:db8:::::1')).toBe('2001:db8:::::1');
  });

  it('buckets a missing address rather than throwing', () => {
    expect(clientKey(undefined)).toBe('unknown');
  });

  it('falls back rather than throwing on an over-long literal', () => {
    // Array(negative) raises RangeError, and one call site is an upgrade
    // listener with no try/catch, so a throw takes the process down.
    for (const addr of ['1:2:3:4:5:6:7:8::9', '1:2:3:4:5:6:7:8:9::']) {
      expect(() => clientKey(addr)).not.toThrow();
      expect(clientKey(addr)).toBe(addr);
    }
  });
});
