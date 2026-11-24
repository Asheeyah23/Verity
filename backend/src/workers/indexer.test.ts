import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org", // never contacted
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused", // pool is lazy
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "x".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const {
  parseLedgerClosedAt,
  buildReplayAttestedPatch,
  buildSpotCheckEvidence,
  buildChallengeOpenedRow,
  buildChallengeResolvedPatch,
  buildChallengeExpiredPatch,
} = await import("./indexer.js");
const { fromChainResolution } = await import("../chain/mappers.js");

test("parseLedgerClosedAt parses valid ISO-8601 ledger close times without warning", () => {
  const warnings: string[] = [];
  const fallback = new Date("2026-11-22T12:00:00Z");

  const utc = parseLedgerClosedAt(
    "2026-11-22T10:00:00Z",
    { id: "0001-0", ledger: 42 },
    () => fallback,
    (msg) => warnings.push(msg)
  );
  assert.equal(utc.toISOString(), "2026-11-22T10:00:00.000Z");

  const withMillis = parseLedgerClosedAt(
    "2026-11-22T10:00:00.250Z",
    { id: "0001-1", ledger: 42 },
    () => fallback,
    (msg) => warnings.push(msg)
  );
  assert.equal(withMillis.toISOString(), "2026-11-22T10:00:00.250Z");

  const withOffset = parseLedgerClosedAt(
    "2026-11-22T12:00:00+02:00",
    { id: "0001-2", ledger: 42 },
    () => fallback,
    (msg) => warnings.push(msg)
  );
  assert.equal(withOffset.toISOString(), "2026-11-22T10:00:00.000Z");

  assert.deepEqual(warnings, []);
});

test("parseLedgerClosedAt falls back to current time with warning on malformed values", () => {
  const fallback = new Date("2026-11-22T12:00:00Z");

  for (const bad of [undefined, null, "", "   ", "not-a-date", "0", "1700000000", "2026-13-01T10:00:00Z"]) {
    const warnings: string[] = [];
    const got = parseLedgerClosedAt(
      bad,
      { id: "ev-99", ledger: 1234 },
      () => fallback,
      (msg) => warnings.push(msg)
    );
    assert.equal(got.getTime(), fallback.getTime(), `expected fallback for ${String(bad)}`);
    assert.equal(warnings.length, 1, `expected one warning for ${String(bad)}`);
    assert.match(warnings[0], /ev-99/);
    assert.match(warnings[0], /1234/);
  }
});

test("buildChallengeOpenedRow records ledger close time for opened_at regardless of indexing delay", () => {
  // Challenge opened at 10:00 on-chain, indexed at 12:00 after a 2h outage.
  const openedOnChain = parseLedgerClosedAt("2026-11-22T10:00:00Z", { id: "ev-1", ledger: 100 });
  const indexedAt = new Date("2026-11-22T12:00:00Z");

  const row = buildChallengeOpenedRow({
    submissionId: "11111111-1111-1111-1111-111111111111",
    challenger: "GCHALLENGER",
    bond: 50_000_000n,
    txHash: "abc123",
    closedAt: openedOnChain,
  });

  assert.deepEqual(row, {
    submission_id: "11111111-1111-1111-1111-111111111111",
    challenger_account: "GCHALLENGER",
    challenger_bond: "50000000",
    chain_tx_hash: "abc123",
    opened_at: openedOnChain,
  });

  // With a 1h challenge window, expiry is due at 11:00 (already elapsed at 12:00),
  // matching the contract's chal.opened_at + challenge_window_s deadline.
  const challengeWindowMs = 3600 * 1000;
  assert.ok(row.opened_at.getTime() + challengeWindowMs <= indexedAt.getTime());
  assert.equal(new Date(row.opened_at.getTime() + challengeWindowMs).toISOString(), "2026-11-22T11:00:00.000Z");
});

test("buildChallengeResolvedPatch records ledger close time for resolved_at", () => {
  const closedAt = parseLedgerClosedAt("2026-11-22T10:30:00Z", { id: "ev-2", ledger: 200 });

  const upheld = buildChallengeResolvedPatch({
    resolution: ["Upheld"],
    method: ["ReexecutionConsensus"],
    closedAt,
  });
  assert.deepEqual(upheld, {
    resolution: "upheld",
    resolution_method: "reexecution_consensus",
    resolved_at: closedAt,
  });

  const noMethod = buildChallengeResolvedPatch({
    resolution: ["Rejected"],
    method: ["None"],
    closedAt,
  });
  assert.deepEqual(noMethod, {
    resolution: "rejected",
    resolution_method: null,
    resolved_at: closedAt,
  });
});

test("buildChallengeExpiredPatch closes the challenge as expired, with no method, at the ledger close time", () => {
  const closedAt = parseLedgerClosedAt("2026-11-22T11:00:05Z", { id: "ev-3", ledger: 260 });

  const patch = buildChallengeExpiredPatch({ closedAt });

  assert.deepEqual(patch, {
    resolution: "expired",
    resolution_method: null,
    resolved_at: closedAt,
  });
  // The same outcome the mapper reports for the record finalize() leaves on-chain.
  assert.equal(patch.resolution, fromChainResolution(["Expired"]));
});

test("buildReplayAttestedPatch and buildSpotCheckEvidence record ledger close time", () => {
  const closedAt = parseLedgerClosedAt("2026-11-22T10:05:15Z", { id: "ev-3", ledger: 150 });
  const outputHash = Buffer.from("deadbeef", "hex");

  const patch = buildReplayAttestedPatch({
    outputHash,
    matched: true,
    txHash: "tx-replay-1",
    closedAt,
  });
  assert.deepEqual(patch, {
    status: "confirmed_onchain",
    replay_output_hash: "deadbeef",
    match: true,
    tx_hash: "tx-replay-1",
    executed_at: closedAt,
  });

  const evidence = buildSpotCheckEvidence({
    replayOutputHash: patch.replay_output_hash,
    txHash: "tx-replay-1",
    ledger: 150,
    closedAt,
  });
  assert.deepEqual(evidence, {
    replay_output_hash: "deadbeef",
    tx_hash: "tx-replay-1",
    ledger: 150,
    ledger_closed_at: "2026-11-22T10:05:15.000Z",
  });
});
