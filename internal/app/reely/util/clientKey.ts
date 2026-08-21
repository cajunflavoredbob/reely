// Per-source key for connection accounting (WS slot caps, auth throttling).
//
// Keying on the raw remoteAddress made both caps meaningless on IPv6. A single
// host is routinely handed a whole /64 and can source from any address in it --
// privacy extensions do this by default, and an attacker does it deliberately.
// Every address became its own key, so a 20-socket-per-IP cap bounded nothing.
//
// The second-order effect was worse than the bypass. Each new address inserted
// a Map entry, and once that Map hit its size cap the "unknown IP" branch
// started refusing every source not already tracked. Filling it costs a
// thousand handshakes, after which real households are locked out while the
// attacker's already-tracked addresses keep working: a cap meant to bound
// memory becomes a denial of service against everyone else.
//
// Grouping IPv6 by /64 is the standard unit of allocation, so it tracks the
// subscriber rather than the ephemeral address.
// Note this does not tighten anything relative to IPv4: a NATed household has
// always shared one key, and the caps that consume this key are sized for a
// household ("multiple browser tabs, a phone, a laptop"), not for one device.
// Grouping by /64 makes IPv6 behave the way IPv4 already did, rather than
// giving every address on a link its own private budget.
const IPV6_GROUP_BITS = 64;

export const clientKey = (remoteAddress: string | undefined): string => {
  if (!remoteAddress) return 'unknown';
  const addr = remoteAddress.trim().toLowerCase();

  // IPv4-mapped IPv6 (::ffff:203.0.113.5) is an IPv4 client; key it as one so
  // the same host gets one bucket whichever way the socket reports it.
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
  // Bail before building the fill array: Array(negative) throws RangeError,
  // and this function's contract (and its only call sites, one of which is an
  // HTTP upgrade listener with no try/catch) is to fall back, never to throw.
  if (head.length + tail.length > 8) return null;
  const groups =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
      : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  // Normalise so 2001:0db8:... and 2001:db8:... share a key.
  return groups.map((g) => g.replace(/^0+(?=.)/, ''));
};
