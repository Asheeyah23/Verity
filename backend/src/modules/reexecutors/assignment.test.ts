import test from "node:test";
import assert from "node:assert/strict";
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

const { assignmentSeed, rankBySeed, replayWantCount, needsFullQuorum, canCastVote, eligibilityFrom } =
  await import("./assignment.js");

test("assignmentSeed produces deterministic sha256 golden vector", () => {
  const seed = assignmentSeed("11111111-1111-1111-1111-111111111111", "7");
  assert.equal(seed, "0162bf36a0368e22c2d3386fd1f53f3af4fe907c8f8dc294fc3f3b95dfa004fa");
});

test("rankBySeed produces deterministic golden orderings for given seeds", () => {
  const seed1 = assignmentSeed("11111111-1111-1111-1111-111111111111", "7");
  const accounts = [
    { stellar_account: "acct-a" },
    { stellar_account: "acct-b" },
    { stellar_account: "acct-c" },
    { stellar_account: "acct-d" },
  ];

  const ranked1 = rankBySeed(seed1, accounts);
  assert.deepEqual(
    ranked1.map((r) => r.stellar_account),
    ["acct-d", "acct-a", "acct-c", "acct-b"]
  );

  const seed2 = assignmentSeed("22222222-2222-2222-2222-222222222222", "7");
  const ranked2 = rankBySeed(seed2, accounts);
  assert.deepEqual(
    ranked2.map((r) => r.stellar_account),
    ["acct-b", "acct-d", "acct-c", "acct-a"]
  );
});

test("rankBySeed is independent of input order and does not mutate input", () => {
  const seed = assignmentSeed("11111111-1111-1111-1111-111111111111", "7");
  const input = [
    { id: "1", stellar_account: "acct-c", meta: "preserve-c" },
    { id: "2", stellar_account: "acct-a", meta: "preserve-a" },
    { id: "3", stellar_account: "acct-d", meta: "preserve-d" },
    { id: "4", stellar_account: "acct-b", meta: "preserve-b" },
  ];
  const inputCopy = JSON.parse(JSON.stringify(input));

  const ranked = rankBySeed(seed, input);
  assert.deepEqual(
    ranked.map((r) => r.stellar_account),
    ["acct-d", "acct-a", "acct-c", "acct-b"]
  );

  // Assert input was not mutated
  assert.deepEqual(input, inputCopy);

  // Assert extra fields are preserved
  assert.equal(ranked[0].id, "3");
  assert.equal(ranked[0].meta, "preserve-d");
  assert.equal(ranked[1].id, "2");
  assert.equal(ranked[1].meta, "preserve-a");
});

test("rankBySeed handles empty list", () => {
  const seed = assignmentSeed("11111111-1111-1111-1111-111111111111", "7");
  const ranked = rankBySeed(seed, []);
  assert.deepEqual(ranked, []);
});

test("replayWantCount calculates seat requirements correctly", () => {
  assert.equal(replayWantCount(3, 1, 0), 4);
  assert.equal(replayWantCount(3, 1, 4), 0);
  assert.equal(replayWantCount(3, 1, 5), -1);
});

test("needsFullQuorum returns true for deterministic tasks", () => {
  assert.equal(
    needsFullQuorum({ task_type: "deterministic", status: "pending", full_replay_requested_at: null }),
    true
  );
});

test("needsFullQuorum returns true for disputed submissions regardless of task type", () => {
  assert.equal(
    needsFullQuorum({ task_type: "retrieval", status: "disputed", full_replay_requested_at: null }),
    true
  );
});

test("needsFullQuorum returns true when full_replay_requested_at is set", () => {
  assert.equal(
    needsFullQuorum({ task_type: "retrieval", status: "pending", full_replay_requested_at: new Date() }),
    true
  );
});

test("needsFullQuorum returns false for non-escalated retrieval submission", () => {
  assert.equal(
    needsFullQuorum({ task_type: "retrieval", status: "pending", full_replay_requested_at: null }),
    false
  );
});

// #294: the mirrored `active` flag is only recomputed when stake changes, so
// after update_config raises min_stake_floor it goes stale. Eligibility must
// follow the contract's live floor, as attest_replay does.
const floor = (minStakeFloor: bigint, allowlist = false) => ({ allowlist, minStakeFloor });
const row = (stake_amount: string, extra: Partial<{ active: boolean; approved: boolean }> = {}) => ({
  active: true,
  approved: true,
  stake_amount,
  ...extra,
});

test("canCastVote rejects an active account whose stake is below a raised floor", () => {
  assert.equal(canCastVote(row("1000"), floor(1000n)), true);
  assert.equal(canCastVote(row("999"), floor(1000n)), false);
  assert.equal(canCastVote(row("1001"), floor(1000n)), true);
});

test("canCastVote still requires active and, under an allow-list, approved", () => {
  assert.equal(canCastVote(row("5000", { active: false }), floor(1000n)), false);
  assert.equal(canCastVote(row("5000", { approved: false }), floor(1000n, true)), false);
  assert.equal(canCastVote(row("5000", { approved: false }), floor(1000n, false)), true);
});

test("canCastVote compares i128 stakes above 2^53 exactly", () => {
  // 2^53 + 1 is not representable as a JS number: Number() rounds it to 2^53.
  const big = 2n ** 53n + 1n;
  assert.equal(canCastVote(row((big - 1n).toString()), floor(big)), false);
  assert.equal(canCastVote(row(big.toString()), floor(big)), true);
  // Near the i128 maximum.
  const max = 2n ** 127n - 1n;
  assert.equal(canCastVote(row((max - 1n).toString()), floor(max)), false);
  assert.equal(canCastVote(row(max.toString()), floor(max)), true);
});

test("canCastVote compares numerically, never as text", () => {
  // As strings "900" > "1000"; as numbers it is below the floor.
  assert.equal(canCastVote(row("900"), floor(1000n)), false);
  assert.equal(canCastVote(row("10000"), floor(9000n)), true);
});

test("canCastVote accepts a numeric with a zero fraction and rejects unparseable stakes", () => {
  assert.equal(canCastVote(row("1000.000"), floor(1000n)), true);
  assert.equal(canCastVote(row("999.5"), floor(1000n)), false);
  assert.equal(canCastVote(row(""), floor(0n)), false);
  assert.equal(canCastVote(row("abc"), floor(0n)), false);
});

test("eligibilityFrom reads the live floor and allow-list from the contract config", () => {
  const big = 2n ** 60n;
  assert.deepEqual(eligibilityFrom({ reexecutor_allowlist: true, min_stake_floor: big }), {
    allowlist: true,
    minStakeFloor: big,
  });
});
