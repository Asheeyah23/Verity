import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const keeper = Keypair.random();
const server = Keypair.random();
const client = Keypair.random();
const passphrase = "Test SDF Network ; September 2015";
const homeDomain = "localhost";
const webAuthDomain = "localhost:3001";
const jwtSecret = "a".repeat(32);

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: passphrase,
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: keeper.secret(),
  SEP10_SIGNING_SECRET: server.secret(),
  JWT_SECRET: jwtSecret,
  WEB_AUTH_DOMAIN: webAuthDomain,
  HOME_DOMAIN: homeDomain,
});

const { authPlugin } = await import("./plugin.js");
const { issueJwt } = await import("./sep10.js");

test("GET /v1/session returns 401 when authorization header is missing", async () => {
  const app = Fastify();
  await app.register(authPlugin);
  const res = await app.inject({
    method: "GET",
    url: "/v1/session",
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: "missing bearer token" });
});

test("GET /v1/session returns 401 when token is invalid or forged", async () => {
  const app = Fastify();
  await app.register(authPlugin);
  const res = await app.inject({
    method: "GET",
    url: "/v1/session",
    headers: {
      authorization: "Bearer invalid.jwt.token",
    },
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(JSON.parse(res.body), { error: "invalid or expired token" });
});

test("GET /v1/session returns verified account for a valid token", async () => {
  const app = Fastify();
  await app.register(authPlugin);
  const token = issueJwt(client.publicKey());
  const res = await app.inject({
    method: "GET",
    url: "/v1/session",
    headers: {
      authorization: `Bearer ${token}`,
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { account: client.publicKey() });
});
