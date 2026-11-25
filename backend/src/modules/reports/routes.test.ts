import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

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
});

const { buildVerificationRatesQuery, buildSlashingEventsCountQuery } = await import("./routes.js");

test("buildSlashingEventsCountQuery compiles without filter when marketplaceId is omitted", () => {
  const query = buildSlashingEventsCountQuery();
  const compiled = query.compile();

  assert.match(compiled.sql, /select count\(\*\) as ("count"|count) from ("slashing_event"|slashing_event)/i);
  assert.doesNotMatch(compiled.sql, /submission/i);
  assert.equal(compiled.parameters.length, 0);
});

test("buildSlashingEventsCountQuery joins submission and scopes to marketplace_id parameter when provided", () => {
  const marketplaceId = "11111111-1111-4111-8111-111111111111";
  const query = buildSlashingEventsCountQuery(marketplaceId);
  const compiled = query.compile();

  assert.match(compiled.sql, /inner join ("submission"|submission)/i);
  assert.match(compiled.sql, /"submission"\."marketplace_id"|submission\.marketplace_id/i);
  assert.equal(compiled.parameters.length, 1);
  assert.equal(compiled.parameters[0], marketplaceId);
});

test("buildVerificationRatesQuery includes marketplace_id filter when provided", () => {
  const marketplaceId = "22222222-2222-4222-8222-222222222222";
  const query = buildVerificationRatesQuery(marketplaceId);
  const compiled = query.compile();

  assert.match(compiled.sql, /"submission"\."marketplace_id"|submission\.marketplace_id/i);
  assert.ok(compiled.parameters.includes(marketplaceId));
});
