import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

// app.ts validates the environment and declares every route (with its rate
// limit) when it is imported. Set the limits these tests turn on before the
// first import; never reuse a developer's .env secrets or contact the Soroban
// RPC. Each test uses its own client address because every window is a minute.
Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  SEP10_SIGNING_SECRET: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
  RUN_WORKERS: "false",
  TRUST_PROXY: "false",
  RATE_LIMIT_PER_MINUTE: "3",
  ARTIFACT_UPLOADS_PER_MINUTE: "2",
  AUTH_REQUESTS_PER_MINUTE: "2",
});

const { buildApp } = await import("./app.js");
const { issueJwt } = await import("./auth/sep10.js");

const app = await buildApp();
after(() => app.close());

type Inject = {
  url: string;
  remoteAddress: string;
  method?: "GET" | "POST";
  token?: string;
  payload?: unknown;
};

/** A fresh, valid bearer token for an account that was never seen before. */
function freshToken(): string {
  return `Bearer ${issueJwt(Keypair.random().publicKey())}`;
}

function send({ url, remoteAddress, method = "GET", token, payload }: Inject) {
  return app.inject({
    method,
    url,
    remoteAddress,
    headers: token ? { authorization: token } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, never> }),
  });
}

test("tokens minted for different accounts share the address's global budget", async () => {
  const ip = "203.0.113.10";
  // A 400 for the malformed hash keeps this off the database; the limiter
  // counts the request first either way.
  const url = "/v1/artifacts/not-a-hash";
  assert.equal((await send({ url, remoteAddress: ip, token: freshToken() })).statusCode, 400);
  assert.equal((await send({ url, remoteAddress: ip, token: freshToken() })).statusCode, 400);
  assert.equal((await send({ url, remoteAddress: ip, token: freshToken() })).statusCode, 400);
  const limited = await send({ url, remoteAddress: ip, token: freshToken() });
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers["retry-after"]);
});

test("the per-account budget follows an account across client addresses", async () => {
  const token = freshToken();
  const url = "/v1/artifacts/not-a-hash";
  for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
    assert.equal((await send({ url, remoteAddress: ip, token })).statusCode, 400);
  }
  // A new address has a fresh address bucket, but this account's budget is spent.
  const limited = await send({ url, remoteAddress: "198.51.100.4", token });
  assert.equal(limited.statusCode, 429);
});

test("/auth has its own lower per-address limit", async () => {
  const ip = "203.0.113.11";
  const accountUrl = () =>
    `/auth?account=${Keypair.random().publicKey()}`;
  assert.equal((await send({ url: accountUrl(), remoteAddress: ip })).statusCode, 200);
  assert.equal((await send({ url: accountUrl(), remoteAddress: ip })).statusCode, 200);
  assert.equal((await send({ url: accountUrl(), remoteAddress: ip })).statusCode, 429);
  // The limit is per address, so another address is not affected.
  assert.equal(
    (await send({ url: accountUrl(), remoteAddress: "203.0.113.12" })).statusCode,
    200,
  );
});

test("the artifact upload limit cannot be bypassed by rotating tokens", async () => {
  const ip = "203.0.113.13";
  const upload = (token: string) =>
    send({ method: "POST", url: "/v1/artifacts", remoteAddress: ip, token, payload: {} });
  // An empty body fails validation after the limiter has counted the request.
  assert.equal((await upload(freshToken())).statusCode, 400);
  assert.equal((await upload(freshToken())).statusCode, 400);
  assert.equal((await upload(freshToken())).statusCode, 429);
});

test("the artifact upload limit also follows one account across addresses", async () => {
  const token = freshToken();
  const upload = (ip: string) =>
    send({ method: "POST", url: "/v1/artifacts", remoteAddress: ip, token, payload: {} });
  assert.equal((await upload("192.0.2.1")).statusCode, 400);
  assert.equal((await upload("192.0.2.2")).statusCode, 400);
  assert.equal((await upload("192.0.2.3")).statusCode, 429);
});
