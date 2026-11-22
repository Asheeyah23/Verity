import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

// storage.ts reads the validated environment at call time; assign before the
// first import so a developer's backend/.env is never used.
const dir = mkdtempSync(path.join(tmpdir(), "verity-artifacts-"));
// A leftover hash-named file from an earlier run counts toward the cap, and
// a half-written temp file does not.
const earlier = Buffer.alloc(30, 7);
writeFileSync(path.join(dir, createHash("sha256").update(earlier).digest("hex")), earlier);
writeFileSync(path.join(dir, `${"a".repeat(64)}.tmp`), Buffer.alloc(500));

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
  ARTIFACT_STORAGE_DIR: dir,
  ARTIFACT_MAX_TOTAL_BYTES: "100",
});

const { storeArtifact, StorageFullError } = await import("./storage.js");

const blob = (size: number, fill: number) => Buffer.alloc(size, fill);

test("storing within the cap succeeds and is content addressed", async () => {
  const content = blob(40, 1); // 30 earlier + 40 = 70 of 100
  const { contentHash } = await storeArtifact(content);
  assert.equal(contentHash, createHash("sha256").update(content).digest("hex"));
});

test("content that would pass the cap is refused and leaves nothing behind", async () => {
  const before = (await readdir(dir)).sort();
  await assert.rejects(storeArtifact(blob(40, 2)), StorageFullError); // 70 + 40 > 100
  assert.deepEqual((await readdir(dir)).sort(), before);
});

test("content that is already stored costs nothing, even when the store is nearly full", async () => {
  await storeArtifact(blob(30, 3)); // 70 + 30 = 100, exactly at the cap
  await storeArtifact(blob(30, 3)); // same bytes again
  await storeArtifact(blob(40, 1)); // an older blob again
  await assert.rejects(storeArtifact(blob(1, 4)), StorageFullError); // now genuinely full
});

test("concurrent uploads cannot both claim the last of the space", async () => {
  // Fresh directory with room for exactly one more 60-byte blob.
  const dir2 = mkdtempSync(path.join(tmpdir(), "verity-artifacts-"));
  const { env } = await import("../../config/env.js");
  env.ARTIFACT_STORAGE_DIR = dir2;
  const results = await Promise.allSettled([storeArtifact(blob(60, 5)), storeArtifact(blob(60, 6))]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
});
