// Per-source key for connection accounting (WS slot caps, auth throttling).
//
// A raw IPv6 remoteAddress is per-connection, not per-client: one host holds a
// whole /64 and sources from any address in it, so every address gets its own
// key and per-IP caps bound nothing. Worse, each address adds a Map entry, and
// once the Map hits its size cap the untracked-IP branch refuses everyone not
// already in it: a memory bound turned into a denial of service.
//
// /64 is the standard allocation unit, so it tracks the subscriber rather than
// the ephemeral address. This matches what IPv4 already did (a NATed household
// has always shared one key) and the caps are sized per household, not per
// device.
const IPV6_GROUP_BITS = 64;

export const clientKey = (remoteAddress: string | undefined): string => {
  if (!remoteAddress) return 'unknown';
  const addr = remoteAddress.trim().toLowerCase();

  // IPv4-mapped (::ffff:203.0.113.5) is an IPv4 client: one bucket whichever
  // way the socket reports it.
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];

  if (!addr.includes(':')) return addr;

  // Drop any zone index (fe80::1%eth0) before parsing.
  const bare = addr.split('%')[0];
  const groups = expandIpv6(bare);
  if (!groups) return addr; // unparseable: fall back to the literal
  const keep = IPV6_GROUP_BITS / 16;
  return `${groups.slice(0, keep).join(':')}::/${IPV6_GROUP_BITS}`;
};

/** Expand an IPv6 literal to its eight 16-bit groups, or null if malformed. */
const expandIpv6 = (addr: string): string[] | null => {
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  // Before the fill array: Array(negative) throws RangeError, and this must
  // fall back rather than throw (one call site is an upgrade listener with no
  // try/catch).
  if (head.length + tail.length > 8) return null;
  const groups =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
      : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  // Normalise so 2001:0db8:... and 2001:db8:... share a key.
  return groups.map((g) => g.replace(/^0+(?=.)/, ''));
};
