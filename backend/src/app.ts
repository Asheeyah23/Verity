import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { sql } from "kysely";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { db } from "./db.js";
import { server } from "./chain/rpc.js";
import { contractErrorName } from "./chain/actions.js";
import { HttpError } from "./http-error.js";
import { authPlugin } from "./auth/plugin.js";
import { verifyJwt } from "./auth/sep10.js";
import { wellKnownPlugin } from "./wellKnown.js";
import { submissionsRoutes } from "./modules/submissions/routes.js";
import { reexecutorsRoutes } from "./modules/reexecutors/routes.js";
import { challengesRoutes } from "./modules/challenges/routes.js";
import { taxonomyRoutes } from "./modules/taxonomy/routes.js";
import { reportsRoutes } from "./modules/reports/routes.js";
import { artifactsRoutes } from "./modules/artifacts/routes.js";
import { marketplacesRoutes } from "./modules/marketplaces/routes.js";
import { configRoutes } from "./modules/config/routes.js";

/** More than this many ledgers (~5s each) behind the chain tip and the
 * indexer is not keeping up: verdicts on the dashboard are stale. */
const MAX_INDEXER_LAG_LEDGERS = 240;

/** How long one readiness result is served before it is computed again, so
 * a burst of /health probes costs one RPC call and two queries. */
const READINESS_CACHE_MS = 5000;

/** Health probes skip the rate limiter. Only the exact health routes do:
 * the query string is ignored, and any other path starting with /health is
 * limited like the rest. */
export function isHealthPath(url: string): boolean {
  const path = url.split("?")[0];
  return path === "/health" || path === "/health/live";
}

type Readiness = { code: number; body: unknown };

async function computeReadiness(): Promise<Readiness> {
  const database = await check(() => sql`select 1`.execute(db));
  let latestLedger: number | null = null;
  const rpc = await check(async () => {
    latestLedger = (await server.getLatestLedger()).sequence;
  });
  let indexerLag: number | null = null;
  if (database && latestLedger !== null) {
    const cursor = await db
      .selectFrom("chain_cursor")
      .select("last_ledger")
      .where("contract_id", "=", env.ESCROW_GATE_CONTRACT_ID)
      .executeTakeFirst();
    // No cursor yet means the indexer has not run its first poll.
    if (cursor) indexerLag = Math.max(0, latestLedger - Number(cursor.last_ledger));
  }
  const indexer = indexerLag === null || indexerLag <= MAX_INDEXER_LAG_LEDGERS;
  const ok = database && rpc && indexer;
  return {
    code: ok ? 200 : 503,
    body: {
      ok,
      deployment: env.DEPLOYMENT_NAME,
      network_passphrase: env.NETWORK_PASSPHRASE,
      escrow_gate_contract_id: env.ESCROW_GATE_CONTRACT_ID,
      workers: env.RUN_WORKERS,
      checks: { database, rpc, indexer, indexer_lag_ledgers: indexerLag },
    },
  };
}

async function check(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

/** The account a valid bearer token names, if there is one. Used only to key
 * the per-account rate limit: routes that need an account still go through
 * requireAuth, which rejects a bad token rather than ignoring it. An invalid
 * token names no account, so it consumes only the address budget. */
function bearerAccount(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  try {
    return verifyJwt(header.slice("Bearer ".length)).sub;
  } catch {
    return undefined;
  }
}

export async function buildApp() {
  // 1 MiB for every request body except POST /v1/artifacts, which sizes its own
  // from ARTIFACT_MAX_BYTES (modules/artifacts/routes.ts).
  const app = Fastify({ logger: true, trustProxy: env.TRUST_PROXY, bodyLimit: 1_048_576 });
  app.register(cookie);
  app.register(helmet);
  // Two independent limiters, because a request must draw from both budgets
  // and the plugin runs at most one limiter per request. Registering it twice
  // gives each registration its own store and its own "already ran" marker.
  // Awaiting matters: the limiter is installed through onRoute, so it must be
  // loaded before the routes below are declared.

  // 1. Per client address, always. Every account one client signs in as draws
  //    from the same address budget, so minting identities cannot multiply it.
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    allowList: (req) => isHealthPath(req.url),
    keyGenerator: (req) => `ip:${req.ip}`,
  });

  // 2. Per account, on top of the address budget. Unauthenticated requests
  //    (and bad tokens) skip it; the address bucket still bounds them.
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    allowList: (req) => isHealthPath(req.url) || bearerAccount(req) === undefined,
    keyGenerator: (req) => `account:${bearerAccount(req)}`,
  });

  // Bad input and contract-level rejections are the caller's problem, not a
  // server fault: surface them as 4xx with the real reason (the contract's
  // own error name) instead of an opaque 500. Anything unexpected is logged
  // in full and answered with nothing that describes this server's insides.
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    const contractError = contractErrorName(err);
    if (contractError) {
      return reply.code(422).send({ error: `EscrowGate rejected the transaction: ${contractError}`, contract_error: contractError });
    }
    const msg = err instanceof Error ? err.message : String(err);
    const accountNotFound = /Account not found:\s*(G[A-Z0-9]{55})/.exec(msg);
    if (accountNotFound) {
      return reply.code(400).send({
        error: `account ${accountNotFound[1]} does not exist on this network; fund it first`,
      });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.code(statusCode).send({ error: err instanceof Error ? err.message : String(err) });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  // Liveness: the process is up. Nothing else is implied.
  app.get("/health/live", async () => ({ ok: true }));

  // Readiness: can this instance actually serve true data right now? The
  // result is cached for READINESS_CACHE_MS, so a caller polling faster than
  // that sees a state at most that stale. The promise itself is cached, so
  // requests that arrive during a refresh share one computation; a failed
  // one is dropped at once instead of being served for the whole TTL.
  let cachedReadiness: { at: number; value: Promise<Readiness> } | null = null;
  function readiness(): Promise<Readiness> {
    const now = Date.now();
    if (cachedReadiness && now - cachedReadiness.at < READINESS_CACHE_MS) {
      return cachedReadiness.value;
    }
    const entry = { at: now, value: computeReadiness() };
    cachedReadiness = entry;
    entry.value.catch(() => {
      if (cachedReadiness === entry) cachedReadiness = null;
    });
    return entry.value;
  }

  app.get("/health", async (_req, reply) => {
    const { code, body } = await readiness();
    reply.code(code);
    return body;
  });

  app.register(wellKnownPlugin);
  app.register(authPlugin);
  app.register(configRoutes);
  app.register(marketplacesRoutes);
  app.register(submissionsRoutes);
  app.register(reexecutorsRoutes);
  app.register(challengesRoutes);
  app.register(taxonomyRoutes);
  app.register(reportsRoutes);
  app.register(artifactsRoutes);
  return app;
}
