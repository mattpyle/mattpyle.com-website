/**
 * Connection pinning: the piece that makes the address check binding rather than
 * advisory.
 *
 * Classifying an address (`net.ts`) and then letting the platform resolve the
 * name again on connect is a check with a hole in the middle. A resolver that
 * answers `93.184.216.34` to the lookup that gets judged and `169.254.169.254`
 * to the lookup that opens the socket passes the guard and reaches the metadata
 * service; that is DNS rebinding, and the window between the two lookups is the
 * whole attack.
 *
 * The fix is to have exactly one lookup. Every connect path in the audit —
 * `safe-fetch.ts`'s undici dispatcher and `vetting-proxy.ts`'s sockets — takes
 * its addresses from here, and the function this module hands to `net.connect`
 * ignores the hostname and returns the addresses that were already vetted. There
 * is no second resolution to poison because there is no second resolution.
 */

/** One resolved, vetted address. The shape `dns.lookup(..., { all: true })` returns. */
export interface PinnedAddress {
  address: string;
  family: number;
}

/**
 * Node's `lookup` hook, in the two shapes callers use it in.
 *
 * `net.connect` calls it with `{ all: true }` whenever happy-eyeballs is in play
 * (the default since Node 20) and expects an array back; with a fixed `family`
 * it expects a single address and its family. Both are answered, because which
 * one arrives is Node's decision and not something to depend on.
 */
export type LookupHook = (
  hostname: string,
  options: { family?: number | 'IPv4' | 'IPv6'; all?: boolean; hints?: number } | number,
  callback: (
    err: NodeJS.ErrnoException | null,
    addressOrAddresses: string | PinnedAddress[],
    family?: number,
  ) => void,
) => void;

/** The error a pinned lookup reports when no vetted address fits what was asked for. */
function noAddress(hostname: string): NodeJS.ErrnoException {
  const err = new Error(`no vetted address for ${hostname}`) as NodeJS.ErrnoException;
  err.code = 'ENOTFOUND';
  return err;
}

/**
 * A `lookup` for `net.connect`/`tls.connect` that answers from `addresses` and
 * never touches a resolver.
 *
 * The hostname argument is deliberately ignored: the caller already decided
 * which addresses this connection is allowed to reach, and honouring the name
 * again here would reintroduce exactly the second lookup this exists to remove.
 * TLS is unaffected — `servername` is set from the URL, so SNI and certificate
 * validation still happen against the name, not against the pinned address.
 */
export function pinnedLookup(addresses: PinnedAddress[]): LookupHook {
  return (hostname, options, callback) => {
    // `family` arrives as 4/6, as 'IPv4'/'IPv6', or as the whole options
    // argument when a caller passes it positionally. Anything else — 0, absent —
    // means "either", and every vetted address qualifies.
    const raw = typeof options === 'number' ? options : options?.family;
    const wanted = raw === 4 || raw === 'IPv4' ? 4 : raw === 6 || raw === 'IPv6' ? 6 : 0;
    const matching = wanted ? addresses.filter((a) => a.family === wanted) : addresses;
    if (matching.length === 0) {
      // The empty address is filler for a signature that wants one; Node reads
      // the error and nothing else.
      callback(noAddress(hostname), '');
      return;
    }
    if (typeof options === 'object' && options?.all) {
      callback(
        null,
        matching.map((a) => ({ address: a.address, family: a.family })),
      );
      return;
    }
    callback(null, matching[0].address, matching[0].family);
  };
}
