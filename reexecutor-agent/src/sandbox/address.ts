import { BlockList, isIP } from "node:net";

// Kept in step with backend/src/modules/webhooks/url-guard.ts, which applies the
// same rule to webhook targets (the two packages share no code).

/** Everything that is not a globally routable unicast address. Webhook and
 * retrieval targets are caller-supplied, so anything that reaches an operator's
 * internal network, a metadata endpoint, or a multicast/reserved range is out. */
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, "ipv4");
}
// Non-global IPv6 blocks from the IANA IPv6 Special-Purpose Address Registry
// (https://www.iana.org/assignments/iana-ipv6-special-registry/): every entry
// marked Globally Reachable = False (plus Teredo, marked N/A, and deprecated
// site-local / multicast). 64:ff9b:1::/48 is rejected outright because the
// position of the embedded IPv4 address depends on the operator's prefix.
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::ffff:0:0:0", 96], // IPv4-translated (RFC 6145)
  ["64:ff9b:1::", 48], // local-use NAT64 (RFC 8215)
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo (RFC 4380)
  ["2001:2::", 48], // benchmarking (RFC 5180)
  ["2001:10::", 28], // deprecated ORCHID (RFC 4843)
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation (RFC 9637)
  ["5f00::", 16], // SRv6 SIDs (RFC 9602)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) {
  NON_PUBLIC.addSubnet(net, prefix, "ipv6");
}

/** Expands an IPv6 literal (compressed and/or with a dotted-quad tail) into
 * its eight 16-bit groups, or null when it is not one. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const tail = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (isIP(tail[2]) !== 4) return null;
    const [a, b, c, d] = tail[2].split(".").map(Number);
    text = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN
  );
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

const dotted = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True for any address that is not publicly routable. IPv6 forms that carry
 * an IPv4 address (mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96,
 * 6to4 2002::/16) are judged by the IPv4 address inside them; the deprecated
 * IPv4-compatible form ::a.b.c.d is never public.
 * Anything that does not parse is treated as non-public. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return NON_PUBLIC.check(ip, "ipv4");
  if (family !== 6 && !ip.includes(":")) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // ::ffff:a.b.c.d is IPv4 in IPv6 clothing; the deprecated IPv4-compatible
    // form ::a.b.c.d (which includes :: and ::1) routes nowhere.
    return g5 === 0xffff ? NON_PUBLIC.check(dotted(g6, g7), "ipv4") : g5 === 0;
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return NON_PUBLIC.check(dotted(g6, g7), "ipv4");
  }
  if (g0 === 0x2002) return NON_PUBLIC.check(dotted(g1, g2), "ipv4");
  return NON_PUBLIC.check(g.map((x) => x.toString(16)).join(":"), "ipv6");
}
