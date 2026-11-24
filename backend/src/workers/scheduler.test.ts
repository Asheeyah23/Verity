import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { ChallengeRecord, SubmissionRecord } from "escrow-gate";

const contractId = StrKey.encodeContract(Buffer.alloc(32));

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: contractId,
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: contractId,
  BOND_ASSET_CONTRACT_ID: contractId,
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const {
  shouldCheckOnChainChallenge,
  submissionRepairPatch,
  reconcileChallengeDecision,
  isReadyToSettle,
} = await import("./scheduler.js");

describe("shouldCheckOnChainChallenge", () => {
  const submittedAtMs = 1_000_000;
  const challengeWindowMs = 300_000; // 300s = 5 min

  it("checks pending submission that has passed its challenge window", () => {
    assert.equal(
      shouldCheckOnChainChallenge({
        status: "pending",
        submittedAtMs,
        challengeWindowMs,
        hasConfirmedVotes: false,
        hasChallengeRow: false,
        nowMs: submittedAtMs + challengeWindowMs + 1,
      }),
      true,
    );
  });

  it("skips pending submission inside window with no confirmed votes", () => {
    assert.equal(
      shouldCheckOnChainChallenge({
        status: "pending",
        submittedAtMs,
        challengeWindowMs,
        hasConfirmedVotes: false,
        hasChallengeRow: false,
        nowMs: submittedAtMs + 50_000,
      }),
      false,
    );
  });

  it("checks pending submission inside window when it already has confirmed votes", () => {
    assert.equal(
      shouldCheckOnChainChallenge({
        status: "pending",
        submittedAtMs,
        challengeWindowMs,
        hasConfirmedVotes: true,
        hasChallengeRow: false,
        nowMs: submittedAtMs + 50_000,
      }),
      true,
    );
  });

  it("checks disputed submission that has no challenge row in DB", () => {
    assert.equal(
      shouldCheckOnChainChallenge({
        status: "disputed",
        submittedAtMs,
        challengeWindowMs,
        hasConfirmedVotes: false,
        hasChallengeRow: false,
      }),
      true,
    );
  });

  it("skips disputed submission that already has a challenge row in DB", () => {
    assert.equal(
      shouldCheckOnChainChallenge({
        status: "disputed",
        submittedAtMs,
        challengeWindowMs,
        hasConfirmedVotes: false,
        hasChallengeRow: true,
      }),
      false,
    );
  });

  it("skips non-pending non-disputed submissions", () => {
    assert.equal(
      shouldCheckOnChainChallenge({
        status: "verified",
        submittedAtMs,
        challengeWindowMs,
        hasConfirmedVotes: true,
        hasChallengeRow: false,
      }),
      false,
    );
  });
});

describe("submissionRepairPatch", () => {
  const baseRecord = {
    submitted_at: 1700000000n,
    challenge_window_s: 300n,
    escrow_value: 10_000_000n,
    cfg_challenger_bond_min_bps: 500, // min bond = 500_000
  } as unknown as SubmissionRecord;

  it("returns null when all fields match", () => {
    const row = {
      submitted_at: new Date(1700000000 * 1000),
      challenge_window_s: 300,
      min_challenger_bond: "500000",
    };
    assert.equal(submissionRepairPatch(row, baseRecord), null);
  });

  it("repairs challenge_window_s when set to 0 from relay error", () => {
    const row = {
      submitted_at: new Date(1700000000 * 1000),
      challenge_window_s: 0,
      min_challenger_bond: "500000",
    };
    const patch = submissionRepairPatch(row, baseRecord);
    assert.deepEqual(patch, { challenge_window_s: 300 });
  });

  it("repairs submitted_at when missing or differing", () => {
    const row = {
      submitted_at: null,
      challenge_window_s: 300,
      min_challenger_bond: "500000",
    };
    const patch = submissionRepairPatch(row, baseRecord);
    assert.deepEqual(patch, { submitted_at: new Date(1700000000 * 1000) });
  });

  it("repairs min_challenger_bond when null or differing", () => {
    const row = {
      submitted_at: new Date(1700000000 * 1000),
      challenge_window_s: 300,
      min_challenger_bond: null,
    };
    const patch = submissionRepairPatch(row, baseRecord);
    assert.deepEqual(patch, { min_challenger_bond: "500000" });
  });

  it("repairs multiple fields simultaneously", () => {
    const row = {
      submitted_at: new Date(1600000000 * 1000),
      challenge_window_s: 0,
      min_challenger_bond: null,
    };
    const patch = submissionRepairPatch(row, baseRecord);
    assert.deepEqual(patch, {
      submitted_at: new Date(1700000000 * 1000),
      challenge_window_s: 300,
      min_challenger_bond: "500000",
    });
  });
});

describe("reconcileChallengeDecision", () => {
  const submissionId = "sub-123";
  const now = new Date("2026-11-23T12:00:00Z");

  const openChainChallenge: ChallengeRecord = {
    challenger: "GCHALLENGER123",
    bond: 500_000n,
    opened_at: 1700000010n,
    resolution: { tag: "None", values: undefined },
    resolution_method: { tag: "None", values: undefined },
  };

  const resolvedChainChallenge: ChallengeRecord = {
    challenger: "GCHALLENGER123",
    bond: 500_000n,
    opened_at: 1700000010n,
    resolution: { tag: "Upheld", values: undefined },
    resolution_method: { tag: "ReexecutionConsensus", values: undefined },
  };

  it("returns none when chain challenge does not exist", () => {
    const decision = reconcileChallengeDecision({
      submissionId,
      status: "pending",
      existingChallenge: null,
      chainChallenge: null,
      now,
    });
    assert.deepEqual(decision, { action: "none" });
  });

  it("decides insert for open challenge when no DB challenge row exists", () => {
    const decision = reconcileChallengeDecision({
      submissionId,
      status: "pending",
      existingChallenge: null,
      chainChallenge: openChainChallenge,
      now,
    });
    assert.deepEqual(decision, {
      action: "insert",
      values: {
        submission_id: submissionId,
        challenger_account: "GCHALLENGER123",
        challenger_bond: "500000",
        opened_at: new Date(1700000010 * 1000),
        chain_tx_hash: null,
      },
      markDisputed: true,
      dispatchWebhook: true,
    });
  });

  it("does not mark disputed if submission is already disputed", () => {
    const decision = reconcileChallengeDecision({
      submissionId,
      status: "disputed",
      existingChallenge: null,
      chainChallenge: openChainChallenge,
      now,
    });
    assert.equal(decision.action, "insert");
    if (decision.action === "insert") {
      assert.equal(decision.markDisputed, false);
      assert.equal(decision.dispatchWebhook, true);
    }
  });

  it("decides insert with resolution filled when chain challenge is already resolved", () => {
    const decision = reconcileChallengeDecision({
      submissionId,
      status: "pending",
      existingChallenge: null,
      chainChallenge: resolvedChainChallenge,
      now,
    });
    assert.deepEqual(decision, {
      action: "insert",
      values: {
        submission_id: submissionId,
        challenger_account: "GCHALLENGER123",
        challenger_bond: "500000",
        opened_at: new Date(1700000010 * 1000),
        chain_tx_hash: null,
        resolution: "upheld",
        resolution_method: "reexecution_consensus",
        resolved_at: now,
      },
      markDisputed: true,
      dispatchWebhook: true,
    });
  });

  it("returns none when DB challenge already exists and both are still open", () => {
    const decision = reconcileChallengeDecision({
      submissionId,
      status: "disputed",
      existingChallenge: { id: "chal-1", resolved_at: null },
      chainChallenge: openChainChallenge,
      now,
    });
    assert.deepEqual(decision, { action: "none" });
  });

  it("decides update when DB challenge is open but chain challenge is resolved", () => {
    const decision = reconcileChallengeDecision({
      submissionId,
      status: "disputed",
      existingChallenge: { id: "chal-1", resolved_at: null },
      chainChallenge: resolvedChainChallenge,
      now,
    });
    assert.deepEqual(decision, {
      action: "update",
      values: {
        resolution: "upheld",
        resolution_method: "reexecution_consensus",
        resolved_at: now,
      },
    });
  });

  it("returns none when DB challenge is already resolved", () => {
    const decision = reconcileChallengeDecision({
      submissionId,
      status: "disputed",
      existingChallenge: { id: "chal-1", resolved_at: new Date("2026-11-20T00:00:00Z") },
      chainChallenge: resolvedChainChallenge,
      now,
    });
    assert.deepEqual(decision, { action: "none" });
  });
});

describe("isReadyToSettle", () => {
  it("rejects non-terminal statuses", () => {
    for (const status of ["pending", "disputed", "draft", "created"]) {
      assert.equal(
        isReadyToSettle({
          status,
          resolution_method: "reexecution_consensus",
          has_attestation: true,
        }),
        false,
        `status ${status} should not be ready to settle`
      );
    }
  });

  it("rejects when resolution_method is null or missing", () => {
    for (const status of ["verified", "slashed", "expired_unverified"]) {
      assert.equal(
        isReadyToSettle({
          status,
          resolution_method: null,
          has_attestation: true,
        }),
        false,
        `status ${status} with null resolution_method should not be ready to settle`
      );
    }
  });

  it("rejects when attestation has not been exported yet", () => {
    for (const status of ["verified", "slashed", "expired_unverified"]) {
      assert.equal(
        isReadyToSettle({
          status,
          resolution_method: "reexecution_consensus",
          has_attestation: false,
        }),
        false,
        `status ${status} without attestation should not be ready to settle`
      );
    }
  });

  it("accepts terminal status with known resolution_method and exported attestation", () => {
    for (const status of ["verified", "slashed", "expired_unverified"]) {
      for (const method of ["reexecution_consensus", "window_elapsed", "zk_proof"]) {
        assert.equal(
          isReadyToSettle({
            status,
            resolution_method: method,
            has_attestation: true,
          }),
          true,
          `status ${status} with method ${method} and attestation should be ready to settle`
        );
      }
    }
  });
});
