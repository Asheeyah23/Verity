import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { HttpError } from "../../http-error.js";

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
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
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

export interface PinnedTarget {
  url: URL;
  /** The one address that passed the check; the request must connect to it. */
  address: string;
  family: 4 | 6;
}

/** A webhook URL is caller-supplied, and this server is the one that calls
 * it: without this check any account could aim Verity at its operator's
 * internal network (cloud metadata endpoints, localhost admin ports). Same
 * rule as the re-executor agent applies to retrieval targets.
 *
 * Returns the address that was checked. The delivery then connects to exactly
 * that address, so the name cannot resolve somewhere else between the check
 * and the connection (DNS rebinding). */
export async function resolvePublicTarget(raw: string): Promise<PinnedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "webhook url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, `unsupported webhook protocol: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  } catch {
    throw new HttpError(400, `webhook host ${host} does not resolve`);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new HttpError(400, `webhook host ${host} resolves to a non-public address`);
  }
  // IPv4 first: plenty of hosts have no IPv6 route.
  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0];
  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/** Validates a webhook URL without keeping the resolved address. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  return (await resolvePublicTarget(raw)).url;
}
