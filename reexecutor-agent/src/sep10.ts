import { Keypair, WebAuth } from "@stellar/stellar-sdk";
import type { FeeBumpTransaction, Transaction } from "@stellar/stellar-sdk";

/**
 * A SEP-10 challenge is a never-submittable transaction: sequence 0, only
 * manageData operations, the first one sourced from the account logging in.
 * The agent signs whatever the backend sends back, so anything else (a
 * payment, a fee bump, a real sequence number) means the backend, or someone
 * between us and it, is asking for a signature on a transaction that could
 * move funds. Throws instead of signing it.
 */
export function assertSep10Challenge(tx: Transaction | FeeBumpTransaction, account: string): void {
  if ("innerTransaction" in tx) throw new Error("SEP-10 challenge is a fee bump transaction; refusing to sign");
  if (tx.sequence !== "0") throw new Error("SEP-10 challenge has a non-zero sequence number; refusing to sign");
  if (tx.operations.length === 0 || tx.operations.some((op) => op.type !== "manageData")) {
    throw new Error("SEP-10 challenge contains operations other than manageData; refusing to sign");
  }
  if (tx.operations[0]?.source !== account) {
    throw new Error("SEP-10 challenge does not name this account in its first operation; refusing to sign");
  }
}

/** Everything a challenge must match before this worker signs it. */
export interface Sep10ServerConfig {
  /** The G... public key that must have signed the challenge. */
  serverKey: string;
  /** Home domain the challenge must name in its first manageData operation ("<domain> auth"). */
  homeDomain: string;
  /** Domain the challenge must name in its web_auth_domain operation. */
  webAuthDomain: string;
}

/** The two values the worker reads out of a SEP-1 stellar.toml. */
export function parseStellarToml(toml: string): { signingKey?: string; webAuthEndpoint?: string } {
  const values: Record<string, string> = {};
  for (const line of toml.split("\n")) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/.exec(line);
    if (match) values[match[1]!] = match[2]!;
  }
  return { signingKey: values.SIGNING_KEY, webAuthEndpoint: values.WEB_AUTH_ENDPOINT };
}

/** Host (with port, if any) of a URL — the part of WEB_AUTH_ENDPOINT that
 * names the deployment's domains. `localhost:3001` keeps its port, which is
 * what the backend puts in its challenges; `api.verity.example` has none. */
function endpointHost(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).host;
  } catch {
    return undefined;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Resolves which server key and domains a challenge must match before this
 * worker signs it. Explicit settings win; anything missing is discovered
 * once from the backend's SEP-1 file, so a local dev run and the compose
 * fleet need no extra configuration. Throws instead of guessing: signing a
 * challenge from an unknown server is how a worker's signature becomes
 * someone else's login.
 */
export async function resolveSep10ServerConfig(options: {
  backendUrl: string;
  serverKey?: string;
  homeDomain?: string;
  webAuthDomain?: string;
}): Promise<Sep10ServerConfig> {
  let serverKey = nonEmpty(options.serverKey);
  let homeDomain = nonEmpty(options.homeDomain);
  let webAuthDomain = nonEmpty(options.webAuthDomain);
  if (!serverKey || !homeDomain || !webAuthDomain) {
    const base = options.backendUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/.well-known/stellar.toml`);
    if (!res.ok) {
      throw new Error(
        `SEP-10 server discovery failed: GET ${base}/.well-known/stellar.toml -> HTTP ${res.status}; set SEP10_SERVER_KEY, SEP10_HOME_DOMAIN and SEP10_WEB_AUTH_DOMAIN to pin them instead`
      );
    }
    const { signingKey, webAuthEndpoint } = parseStellarToml(await res.text());
    serverKey ??= signingKey;
    const host = webAuthEndpoint ? endpointHost(webAuthEndpoint) : undefined;
    homeDomain ??= host;
    webAuthDomain ??= host;
  }
  if (!serverKey) {
    throw new Error(
      "SEP-10 server key is unknown: set SEP10_SERVER_KEY or make sure the backend's stellar.toml publishes SIGNING_KEY; refusing to sign"
    );
  }
  try {
    Keypair.fromPublicKey(serverKey);
  } catch {
    throw new Error(`SEP-10 server key is not a valid G... public key: "${serverKey}"`);
  }
  if (!homeDomain) {
    throw new Error(
      "SEP-10 home domain is unknown: set SEP10_HOME_DOMAIN or make sure the backend's stellar.toml publishes WEB_AUTH_ENDPOINT; refusing to sign"
    );
  }
  if (!webAuthDomain) {
    throw new Error(
      "SEP-10 web-auth domain is unknown: set SEP10_WEB_AUTH_DOMAIN or make sure the backend's stellar.toml publishes WEB_AUTH_ENDPOINT; refusing to sign"
    );
  }
  return { serverKey, homeDomain, webAuthDomain };
}

/**
 * Verifies a challenge XDR the way SEP-10 requires before this worker signs
 * it: `WebAuth.readChallengeTx` checks that the expected server key signed
 * it, for the expected network, home domain and web-auth domain, and inside
 * its time bounds — then the shape checks in `assertSep10Challenge` still
 * apply (sequence 0, manageData only, first operation from this account).
 * Returns the parsed transaction, ready to sign. Throws with a clear reason
 * instead of signing anything else.
 */
export function verifySep10Challenge(
  challengeXdr: string,
  config: Sep10ServerConfig,
  networkPassphrase: string,
  account: string
): Transaction {
  const { tx } = WebAuth.readChallengeTx(
    challengeXdr,
    config.serverKey,
    networkPassphrase,
    [config.homeDomain],
    config.webAuthDomain
  );
  assertSep10Challenge(tx, account);
  return tx;
}

/**
 * True when BACKEND_URL is plain http to a public host: a challenge fetched
 * over it can be swapped by anyone on the path, and the worker would hand
 * its signature to a stranger. Loopback and single-label names (a compose
 * service such as `backend`) are internal, not public.
 */
export function isInsecureBackendUrl(backendUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(backendUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return false;
  // A host with no dot is an internal name, not a public host a stranger can serve.
  if (!host.includes(".")) return false;
  return true;
}
