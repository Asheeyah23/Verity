import http from "node:http";
import https from "node:https";
import type { PinnedTarget } from "./url-guard.js";

/** One POST to the address `resolvePublicTarget` vetted, whatever DNS says
 * now. The URL keeps its hostname, so the Host header, TLS SNI and certificate
 * check are those of the real name. Redirects are never followed: a 3xx is
 * just a non-2xx answer. Resolves with the status code once the headers are in
 * (the body is discarded); rejects on a network error or when `timeoutMs` has
 * passed in total, so a server that stalls or trickles bytes cannot hold a
 * delivery open. */
export function postPinned(
  target: PinnedTarget,
  opts: { headers: Record<string, string>; body: string; timeoutMs: number }
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    const req = transport.request(
      target.url,
      {
        method: "POST",
        headers: { ...opts.headers, "content-length": String(Buffer.byteLength(opts.body)) },
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
        const status = res.statusCode ?? 0;
        // Only the status matters; drop the connection instead of reading on.
        res.destroy();
        resolve({ status });
      }
    );
    const deadline = setTimeout(
      () => req.destroy(new Error(`not finished within ${opts.timeoutMs / 1000}s`)),
      opts.timeoutMs
    );
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end(opts.body);
  });
}
