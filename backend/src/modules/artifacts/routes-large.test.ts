import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

// The case from the bug report: an operator allows 1 MiB artifacts. As base64
// that is about 1.4 MB of JSON, more than the app-wide 1 MiB body limit, so
// before the route had its own limit nothing over about 786 KB could arrive.
// The environment is read at import time, so this limit has its own file.
const MAX_BYTES = 1_048_576;
Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  ATTESTATION_SIGNING_SECRET: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
  ARTIFACT_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), "verity-artifact-routes-large-")),
  ARTIFACT_MAX_BYTES: String(MAX_BYTES),
});

const { buildApp } = await import("../../app.js");
const { issueJwt } = await import("../../auth/sep10.js");

const app = await buildApp();
app.log.level = "silent";
after(() => app.close());

const token = issueJwt(Keypair.random().publicKey());
const upload = (bytes: number, fill: number) => {
  const payload = JSON.stringify({ content_base64: Buffer.alloc(bytes, fill).toString("base64") });
  return {
    bodyBytes: payload.length,
    response: app.inject({
      method: "POST",
      url: "/v1/artifacts",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload,
    }),
  };
};

test("a 900 KB artifact uploads when ARTIFACT_MAX_BYTES allows 1 MiB", async () => {
  const { bodyBytes, response } = upload(900_000, 1);
  assert.ok(bodyBytes > 1_048_576, "its JSON is larger than the app-wide body limit");
  const res = await response;
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().size_bytes, 900_000);
});

test("an artifact exactly 1 MiB long uploads", async () => {
  const res = await upload(MAX_BYTES, 2).response;
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().size_bytes, MAX_BYTES);
});

test("one byte over 1 MiB gets the 413 that names the limit", async () => {
  const res = await upload(MAX_BYTES + 1, 3).response;
  assert.equal(res.statusCode, 413, res.body);
  assert.deepEqual(res.json(), { error: `artifact is larger than the ${MAX_BYTES}-byte limit` });
});
