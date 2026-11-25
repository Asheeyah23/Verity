import assert from "node:assert/strict";
import test from "node:test";
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

const { buildApp } = await import("../app.js");

test("OPTIONS /auth preflight returns 204 and CORS allow headers", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "OPTIONS",
    url: "/auth",
    headers: {
      origin: "https://market.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.match(String(res.headers["access-control-allow-methods"]), /POST/i);
});

test("GET /auth (200) includes access-control-allow-origin: *", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/auth?account=${client.publicKey()}`,
    headers: {
      origin: "https://market.example",
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], "*");
});

test("GET /auth (400) includes access-control-allow-origin: *", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: `/auth?account=invalid_account_key`,
    headers: {
      origin: "https://market.example",
    },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.headers["access-control-allow-origin"], "*");
});

test("POST /auth (400 on invalid body) includes access-control-allow-origin: *", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "POST",
    url: "/auth",
    headers: {
      origin: "https://market.example",
      "content-type": "application/json",
    },
    payload: { transaction: "invalid_xdr" },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.headers["access-control-allow-origin"], "*");
});

test("/v1/* routes do not include access-control-allow-origin header", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/v1/taxonomy",
    headers: {
      origin: "https://market.example",
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});
