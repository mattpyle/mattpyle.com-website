/**
 * Address classification for the audit fetcher — the "is this address allowed to
 * be connected to" half of the SSRF guard (hosted-mcp-server card, Security).
 *
 * Pure and network-free on purpose: the ranges are the part of the guard most
 * likely to be wrong, and a table of literal addresses in a unit test is the
 * only way to know they are not. `safe-fetch.ts` owns DNS, redirects and caps
 * and calls in here for the verdict.
 *
 * The rule this module encodes: an auditor that will fetch any URL a stranger
 * hands it is a proxy into whatever network it runs on. Everything that is not
 * a globally-routable unicast address is refused, rather than a denylist of the
 * addresses known to be interesting (169.254.169.254 and friends) — a denylist
 * of interesting targets misses the next interesting target.
 */

/** Why an address was refused; `null` means it is allowed. */
export type BlockReason = string;

interface Range4 {
  cidr: string;
  reason: string;
}

/**
 * IPv4 ranges refused before connecting. Reasons are written to be printed at a
 * human: they end up verbatim in the CLI's refusal message.
 */
const BLOCKED_V4: Range4[] = [
  { cidr: '0.0.0.0/8', reason: '"this network" (RFC 1122)' },
  { cidr: '10.0.0.0/8', reason: 'private network (RFC 1918)' },
  { cidr: '100.64.0.0/10', reason: 'carrier-grade NAT (RFC 6598) — also Alibaba/Oracle metadata' },
  { cidr: '127.0.0.0/8', reason: 'loopback' },
  { cidr: '169.254.0.0/16', reason: 'link-local — includes the 169.254.169.254 cloud metadata service' },
  { cidr: '172.16.0.0/12', reason: 'private network (RFC 1918)' },
  { cidr: '192.0.0.0/24', reason: 'IETF protocol assignments (RFC 6890)' },
  { cidr: '192.0.2.0/24', reason: 'documentation range TEST-NET-1' },
  { cidr: '192.88.99.0/24', reason: 'deprecated 6to4 relay anycast' },
  { cidr: '192.168.0.0/16', reason: 'private network (RFC 1918)' },
  { cidr: '198.18.0.0/15', reason: 'benchmarking range (RFC 2544)' },
  { cidr: '198.51.100.0/24', reason: 'documentation range TEST-NET-2' },
  { cidr: '203.0.113.0/24', reason: 'documentation range TEST-NET-3' },
  { cidr: '224.0.0.0/4', reason: 'multicast' },
  { cidr: '240.0.0.0/4', reason: 'reserved — includes 255.255.255.255 broadcast' },
];

/** Dotted-quad to a 32-bit unsigned integer, or `null` if it is not one. */
export function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    // Reject "01", "+1", "0x7f" and friends explicitly. Several historical SSRF
    // bypasses are exactly this: a parser that accepts an octal or hex octet
    // where the checker assumed decimal.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function inCidr4(addr: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const baseAddr = parseIPv4(base);
  if (baseAddr === null) return false;
  const bits = Number(bitsRaw);
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) >>> 0 === (baseAddr & mask) >>> 0;
}

/**
 * Expands an IPv6 literal into its eight 16-bit groups, or `null`.
 *
 * Handles `::` compression, an embedded IPv4 tail (`::ffff:1.2.3.4`), and a
 * zone id (`fe80::1%eth0`) — the last of which is stripped rather than parsed,
 * since a scoped address is link-local and refused anyway.
 */
export function expandIPv6(ip: string): number[] | null {
  let text = ip.split('%')[0];
  if (text.includes('.')) {
    // An IPv4 tail: convert it to the two trailing hextets and re-parse.
    const lastColon = text.lastIndexOf(':');
    const tail = text.slice(lastColon + 1);
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    const hi = (v4 >>> 16).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function inCidr6(groups: number[], prefix: string, bits: number): boolean {
  const base = expandIPv6(prefix);
  if (!base) return false;
  for (let i = 0; i < 8; i++) {
    const groupBits = Math.min(16, Math.max(0, bits - i * 16));
    if (groupBits === 0) return true;
    const mask = (0xffff << (16 - groupBits)) & 0xffff;
    if ((groups[i] & mask) !== (base[i] & mask)) return false;
  }
  return true;
}

/**
 * The verdict on one resolved address: a human-readable reason to refuse it, or
 * `null` for "globally routable, go ahead".
 *
 * Anything that does not parse as an address is refused too. A string that
 * reached here and is not an IP means DNS returned something unexpected, and
 * "unrecognised" is not a safe default to connect to.
 */
export function classifyAddress(ip: string): BlockReason | null {
  const v4 = parseIPv4(ip);
  if (v4 !== null) {
    for (const range of BLOCKED_V4) {
      if (inCidr4(v4, range.cidr)) return `${ip} is in ${range.cidr} — ${range.reason}`;
    }
    return null;
  }

  const groups = expandIPv6(ip);
  if (!groups) return `${ip} is not a recognised IP address`;

  // IPv4-mapped (::ffff:0:0/96) and IPv4-translated (::ffff:0:0:0/96, 64:ff9b::/96)
  // addresses carry a v4 address inside a v6 one — a documented way to smuggle
  // 127.0.0.1 past a v6-only check. Unwrap and judge the v4 address on its own
  // terms, then keep going in case the wrapper itself is also blocked.
  const embedded =
    inCidr6(groups, '::ffff:0:0', 96) || inCidr6(groups, '64:ff9b::', 96)
      ? `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`
      : null;
  if (embedded) {
    const inner = classifyAddress(embedded);
    if (inner) return `${ip} embeds ${embedded}: ${inner}`;
    return null;
  }

  const blocked6: Array<[string, number, string]> = [
    ['::', 128, 'unspecified address'],
    ['::1', 128, 'loopback'],
    ['100::', 64, 'discard-only prefix (RFC 6666)'],
    ['2001:db8::', 32, 'documentation range'],
    ['fc00::', 7, 'unique local address (RFC 4193)'],
    ['fe80::', 10, 'link-local'],
    ['ff00::', 8, 'multicast'],
  ];
  for (const [prefix, bits, reason] of blocked6) {
    if (inCidr6(groups, prefix, bits)) return `${ip} is in ${prefix}/${bits} — ${reason}`;
  }
  return null;
}
