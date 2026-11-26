import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import jwt from "jsonwebtoken";

// Drives the real HTTP app with app.inject: the auth gate, request validation
// and the error handler, as README.md "API" documents them. Nothing here
// reaches Postgres or the Soroban RPC: the pg pool is lazy and connects only
// when a query runs, and every request below is answered before that.
//
// app.ts validates the environment when it is imported, so set it first and
// never reuse a developer's .env secrets.
const JWT_SECRET = "j".repeat(32);
Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org", // never contacted
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  SEP10_SIGNING_SECRET: Keypair.random().secret(),
  JWT_SECRET,
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
  RUN_WORKERS: "false",
  TRUST_PROXY: "false",
  // Low on purpose, so the health-path exemption is observable. Every other
  // request uses its own client address (nextIp) and so never hits it.
  RATE_LIMIT_PER_MINUTE: "3",
});

const { buildApp } = await import("./app.js");
const { issueJwt, sep10SigningKey } = await import("./auth/sep10.js");
const { webAuthEndpoint } = await import("./config/env.js");
const { HttpError } = await import("./http-error.js");
const { db } = await import("./db.js");

const app = await buildApp();

// Throwaway routes for the error handler. Registered before ready(), like
// every real route.
app.get("/__test/http-error", async () => {
  throw new HttpError(418, "x");
});
app.get("/__test/contract-error", async () => {
  throw new Error("HostError: Error(Contract, #11)");
});
app.get("/__test/internal-error", async () => {
  throw new Error("secret sql: select * from reexecutor where password = 'hunter2'");
});

await app.ready();

after(async () => {
  await app.close();
  await db.destroy();
});

let ipCounter = 0;
/** A fresh client address per request keeps the per-address limiter out of
 * every test except the one about it. */
function ip(): string {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 250)}.${ipCounter % 250}.1`;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const validToken = () => issueJwt(Keypair.random().publicKey());

/** Every Bearer route in README.md's API table, plus GET /v1/session.
 * Path parameters are filled with well-formed but unknown values. If
 * requireAuth is dropped from any of them, its 401 tests fail: the request
 * then reaches validation (400) or the unreachable database (500) instead. */
const BEARER_ROUTES: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; route: string }> = [
  { method: "GET", route: "/v1/session" },
  { method: "POST", route: "/v1/artifacts" },
  { method: "POST", route: "/v1/submissions" },
  { method: "POST", route: "/v1/submissions/:id/relay" },
  { method: "POST", route: "/v1/submissions/:id/challenge" },
  { method: "POST", route: "/v1/submissions/:id/challenge/relay" },
  { method: "POST", route: "/v1/reexecutors" },
  { method: "POST", route: "/v1/reexecutors/:id/withdraw" },
  { method: "POST", route: "/v1/reexecutors/:id/relay" },
  { method: "POST", route: "/v1/reexecutors/:id/heartbeat" },
  { method: "POST", route: "/v1/reexecutors/sync" },
  { method: "GET", route: "/v1/reexecutors/:id/assignments" },
  { method: "POST", route: "/v1/marketplaces" },
  { method: "POST", route: "/v1/marketplaces/:id/webhooks" },
  { method: "GET", route: "/v1/marketplaces/:id/webhooks" },
  { method: "PATCH", route: "/v1/marketplaces/:id/webhooks/:webhookId" },
  { method: "DELETE", route: "/v1/marketplaces/:id/webhooks/:webhookId" },
];

const UNKNOWN_ID = "3f1c2b7e-9a4d-4e8b-b5c6-0d1e2f3a4b5c";
const urlFor = (route: string) =>
  route.replace(":webhookId", UNKNOWN_ID).replace(":id", UNKNOWN_ID);

function hit(method: (typeof BEARER_ROUTES)[number]["method"], route: string, headers: Record<string, string>) {
  return app.inject({
    method,
    url: urlFor(route),
    remoteAddress: ip(),
    headers,
    ...(method === "POST" || method === "PATCH" ? { payload: {} } : {}),
  });
}

for (const { method, route } of BEARER_ROUTES) {
  test(`${method} ${route} without a token is 401 missing bearer token`, async () => {
    const res = await hit(method, route, {});
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "missing bearer token" });
  });

  test(`${method} ${route} with a non-Bearer scheme is 401 missing bearer token`, async () => {
    const res = await hit(method, route, { authorization: `Basic ${validToken()}` });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "missing bearer token" });
  });

  test(`${method} ${route} with a garbage token is 401 invalid or expired token`, async () => {
    const res = await hit(method, route, bearer("not.a.jwt"));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "invalid or expired token" });
  });

  test(`${method} ${route} with a token signed by another secret is 401`, async () => {
    const forged = jwt.sign({ sub: Keypair.random().publicKey() }, "x".repeat(32), {
      algorithm: "HS256",
      issuer: webAuthEndpoint,
      expiresIn: "1h",
    });
    const res = await hit(method, route, bearer(forged));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "invalid or expired token" });
  });

  test(`${method} ${route} with an expired token is 401`, async () => {
    const expired = jwt.sign(
      { sub: Keypair.random().publicKey(), exp: Math.floor(Date.now() / 1000) - 60 },
      JWT_SECRET,
      { algorithm: "HS256", issuer: webAuthEndpoint }
    );
    const res = await hit(method, route, bearer(expired));
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: "invalid or expired token" });
  });
}

test("GET /v1/session with a valid token returns the token's account", async () => {
  const account = Keypair.random().publicKey();
  const res = await app.inject({
    method: "GET",
    url: "/v1/session",
    remoteAddress: ip(),
    headers: bearer(issueJwt(account)),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { account });
});

/** README "Errors": 400 `{ "error": "<path>: <message>; …" }`, one entry per field. */
function assertValidationError(body: { error: unknown }, fields: string[]) {
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.equal(typeof body.error, "string");
  const entries = (body.error as string).split("; ");
  for (const field of fields) {
    assert.ok(
      entries.some((e) => e.startsWith(`${field}: `)),
      `expected an entry for ${field} in ${JSON.stringify(body.error)}`
    );
  }
}

test("POST /v1/submissions with an invalid body is 400 in the documented format", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/submissions",
    remoteAddress: ip(),
    headers: bearer(validToken()),
    payload: { task_type: "not-a-task-type" },
  });
  assert.equal(res.statusCode, 400);
  assertValidationError(res.json(), ["task_type"]);
});

test("POST /v1/artifacts with an invalid body is 400 in the documented format", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/artifacts",
    remoteAddress: ip(),
    headers: bearer(validToken()),
    payload: { content_base64: 42, content_type: "x".repeat(256) },
  });
  assert.equal(res.statusCode, 400);
  assertValidationError(res.json(), ["content_base64", "content_type"]);
});

test("an HttpError keeps its status and message", async () => {
  const res = await app.inject({ method: "GET", url: "/__test/http-error", remoteAddress: ip() });
  assert.equal(res.statusCode, 418);
  assert.deepEqual(res.json(), { error: "x" });
});

test("a contract error is 422 with the contract's own error name", async () => {
  const res = await app.inject({ method: "GET", url: "/__test/contract-error", remoteAddress: ip() });
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.contract_error, "BondTooLow");
  assert.equal(body.error, "EscrowGate rejected the transaction: BondTooLow");
});

test("any other error is 500 internal error and leaks nothing", async () => {
  const res = await app.inject({ method: "GET", url: "/__test/internal-error", remoteAddress: ip() });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.json(), { error: "internal error" });
  assert.ok(!res.body.includes("secret"));
  assert.ok(!res.body.includes("hunter2"));
});

test("GET /.well-known/stellar.toml advertises the SEP-10 endpoint with CORS *", async () => {
  const res = await app.inject({ method: "GET", url: "/.well-known/stellar.toml", remoteAddress: ip() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.match(String(res.headers["content-type"]), /^text\/plain/);
  assert.deepEqual(res.body.split("\n"), [
    `NETWORK_PASSPHRASE="Test SDF Network ; September 2015"`,
    `WEB_AUTH_ENDPOINT="${webAuthEndpoint}"`,
    `SIGNING_KEY="${sep10SigningKey}"`,
  ]);
  assert.equal(webAuthEndpoint.endsWith("://localhost:3001/auth"), true);
});

test("GET /health/live is 200 { ok: true }", async () => {
  const res = await app.inject({ method: "GET", url: "/health/live", remoteAddress: ip() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test("health probes skip the rate limiter; other paths from the same address do not", async () => {
  const remoteAddress = "192.0.2.77";
  const limit = 3; // RATE_LIMIT_PER_MINUTE above
  for (let i = 0; i < limit * 3; i++) {
    const res = await app.inject({ method: "GET", url: "/health/live", remoteAddress });
    assert.equal(res.statusCode, 200, `health probe ${i + 1} was limited`);
  }
  // The same address still has its whole budget for everything else.
  // /v1/session without a token is 401 and never touches the database.
  for (let i = 0; i < limit; i++) {
    const res = await app.inject({ method: "GET", url: "/v1/session", remoteAddress });
    assert.equal(res.statusCode, 401, `request ${i + 1} should be within the budget`);
  }
  const limited = await app.inject({ method: "GET", url: "/v1/session", remoteAddress });
  assert.equal(limited.statusCode, 429);
});
