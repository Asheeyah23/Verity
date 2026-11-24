import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { canonicalHash } from "./canonical.js";
import { isPrivateAddress } from "./address.js";

export { isPrivateAddress };

/**
 * The input artifact of a retrieval task: the request the agent claims to
 * have made. A re-executor re-issues exactly this request and compares the
 * (optionally JSON-pointer-extracted) result with the agent's claimed output.
 */
export interface RetrievalSpec {
  url: string;
  /** RFC 6901 JSON pointer into a JSON response body, e.g. "/data/0/price". */
  pointer?: string;
}

const MAX_BODY_BYTES = 1_000_000;
const TIMEOUT_MS = 10_000;
/** Hard cap on one whole request. TIMEOUT_MS only trips on silence, so a
 * server dripping a byte every few seconds would otherwise hold the worker
 * (and its heartbeat) for as long as it likes. */
const TOTAL_TIMEOUT_MS = 30_000;
/** Sent on every retrieval request. Keep fixed across versions (and in sync with
 * README.md) so target behaviour does not vary by worker version. */
export const RETRIEVAL_USER_AGENT = "Verity-Reexecutor/1 (+https://github.com/DevQwinB/Verity)";

/**
 * The target could not be reached (DNS failure including ENOTFOUND, network error),
 * or answered in a way that says "try again" or is inconclusive (>= 500, 408,
 * 429, 401, 403, 451). That may be the target, or it may be this host's
 * resolver, network or IP range — and a vote is irreversible — so the caller
 * retries for a while and then checks its own connectivity before concluding
 * anything (after the retry budget a still-failing target is voted as a
 * mismatch).
 */
export class RetrievalTransientError extends Error {}

interface PinnedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** A retrieval spec is attacker-controlled input: without this, any agent
 * could point re-executors at their operator's internal network (cloud
 * metadata endpoints, localhost admin ports) and read the result back.
 *
 * Returns the one address that was checked. The request is then made to
 * exactly that address, so the name cannot resolve somewhere else between
 * the check and the connection.
 *
 * allowPrivate skips only the non-public-address refusal, for URLs that come
 * from the operator's own configuration. It defaults to false so a caller
 * that forgets it fails closed. */
export async function resolvePublicTarget(raw: string, opts: { allowPrivate: boolean } = { allowPrivate: false }): Promise<PinnedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`retrieval url is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`unsupported retrieval protocol: ${url.protocol}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string; family: number }>;
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // The resolver on this host can answer NXDOMAIN wrongly (e.g. captive
      // portal or flaky DNS), and a vote is irreversible: treat failure to resolve
      // as inconclusive rather than an immediate mismatch.
      throw new RetrievalTransientError(`could not resolve ${host}: ${code ?? (err as Error).message}`);
    }
  }
  if (addresses.length === 0) throw new Error(`retrieval host ${host} has no address`);
  if (!opts.allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`retrieval target ${host} resolves to a non-public address`);
  }
  // IPv4 first: plenty of hosts have no IPv6 route.
  const chosen = addresses.find((a) => a.family === 4) ?? addresses[0];
  return { url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/** One GET to the pinned address, never following redirects. Resolves with
 * any HTTP response; rejects with RetrievalTransientError when no response
 * could be obtained. */
export function getPinned(target: PinnedTarget, totalTimeoutMs = TOTAL_TIMEOUT_MS): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    const req = transport.get(
      target.url,
      {
        headers: {
          accept: "application/json, text/plain;q=0.9, */*;q=0.1",
          "user-agent": RETRIEVAL_USER_AGENT,
        },
        timeout: TIMEOUT_MS,
        // Connect to the address that was vetted, whatever DNS says now.
        lookup: (_hostname, options, callback) => {
          if (typeof options === "object" && options.all) {
            (callback as (err: null, addresses: Array<{ address: string; family: number }>) => void)(null, [
              { address: target.address, family: target.family },
            ]);
          } else {
            (callback as (err: null, address: string, family: number) => void)(null, target.address, target.family);
          }
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy();
            reject(new Error("retrieval response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (err) => reject(new RetrievalTransientError(`response interrupted: ${err.message}`)));
      }
    );
    req.on("timeout", () => req.destroy(new RetrievalTransientError(`no response within ${TIMEOUT_MS / 1000}s`)));
    const deadline = setTimeout(
      () => req.destroy(new RetrievalTransientError(`not finished within ${totalTimeoutMs / 1000}s`)),
      totalTimeoutMs
    );
    req.on("close", () => clearTimeout(deadline));
    req.on("error", (err) =>
      reject(err instanceof RetrievalTransientError ? err : new RetrievalTransientError(`request failed: ${err.message}`))
    );
  });
}

const CANONICAL_ARRAY_INDEX = /^(0|[1-9]\d*)$/;

export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON pointer: ${pointer}`);
  let node: any = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") {
      throw new Error(`JSON pointer ${pointer} does not resolve in the response`);
    }
    if (Array.isArray(node)) {
      if (!CANONICAL_ARRAY_INDEX.test(key)) {
        throw new Error(`JSON pointer ${pointer} does not resolve in the response`);
      }
      const index = Number(key);
      if (index >= node.length) {
        throw new Error(`JSON pointer ${pointer} does not resolve in the response`);
      }
      node = node[index];
    } else {
      if (!Object.hasOwn(node, key)) {
        throw new Error(`JSON pointer ${pointer} does not resolve in the response`);
      }
      node = node[key];
    }
  }
  return node;
}

/**
 * Returns true if an HTTP status indicates an inconclusive result (e.g. rate limit,
 * transient server error, or client IP-specific restriction like WAF/geo-block:
 * 401, 403, 408, 429, 451, or >= 500).
 */
export function isInconclusiveStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429 || status === 401 || status === 403 || status === 451;
}

/**
 * Re-issues the declared request. Throws a plain Error for an outcome that
 * settles the question against the submission (bad spec, credentials in URL,
 * private target, redirect, definitive 4xx like 404/410, oversize, pointer
 * that does not resolve), and a RetrievalTransientError for one that is
 * inconclusive (unresolvable host, target unreachable, >= 500, 408, 429, 401,
 * 403, 451).
 * After the retry budget a still-failing target is voted as a mismatch.
 */
export async function runRetrieval(spec: RetrievalSpec): Promise<{ outputHash: string; output: unknown; engine: string }> {
  if (!spec || typeof spec.url !== "string") {
    throw new Error('retrieval input artifact must be JSON of the form {"url": "...", "pointer"?: "/..."}');
  }
  let parsed: URL;
  try {
    parsed = new URL(spec.url);
  } catch {
    throw new Error(`retrieval url is not a valid URL: ${spec.url}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("retrieval url must not contain credentials");
  }
  const target = await resolvePublicTarget(spec.url);
  const res = await getPinned(target);
  // A redirect could bounce to a private address, and a moved resource is a
  // legitimate mismatch anyway: the agent declared this URL, not another.
  if (res.status >= 300 && res.status < 400) throw new Error(`retrieval target redirected (HTTP ${res.status})`);
  if (isInconclusiveStatus(res.status)) {
    throw new RetrievalTransientError(`retrieval target answered HTTP ${res.status}`);
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`retrieval target answered HTTP ${res.status}`);

  let body: unknown = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    if (spec.pointer) throw new Error("a JSON pointer was given but the response is not JSON");
  }
  const output = spec.pointer !== undefined ? resolvePointer(body, spec.pointer) : body;
  return { outputHash: canonicalHash(output), output, engine: "http-refetch (public egress only, address pinned)" };
}

/** True if this host can reach its known-good endpoint at all: any HTTP
 * answer counts. Used before blaming a target for being unreachable.
 *
 * controlUrl comes from the operator's own configuration (by default their
 * Soroban RPC URL, often on localhost or a private network), not from a
 * submitter, so it may resolve to a private address. That is deliberately
 * not true of retrieval targets: runRetrieval still refuses them. */
export async function hasConnectivity(controlUrl: string): Promise<boolean> {
  try {
    await getPinned(await resolvePublicTarget(controlUrl, { allowPrivate: true }));
    return true;
  } catch {
    return false;
  }
}
