import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeVerdict } from "./verdict.ts";

const STATUSES = ["pending", "verified", "disputed", "slashed", "expired_unverified"];
const METHODS = ["reexecution_consensus", "window_elapsed", "zk_proof", null, undefined];
const CHALLENGES = [true, false];

describe("describeVerdict combinations", () => {
  for (const status of STATUSES) {
    for (const method of METHODS) {
      for (const hasChallenge of CHALLENGES) {
        it(`status=${status}, method=${method}, hasChallenge=${hasChallenge}`, () => {
          const res = describeVerdict(status, method, hasChallenge);
          assert.ok(res.label, "must have label");
          assert.ok(res.tone, "must have tone");
          assert.ok(res.mechanism, "must have mechanism");
          assert.ok(res.short, "must have short");

          // Hard requirement: window_elapsed never returns tone verified
          if (method === "window_elapsed") {
            assert.notEqual(res.tone, "verified", "window_elapsed must never return tone verified");
          }

          // No label contains "ZK" unless the method is zk_proof
          if (res.label.includes("ZK")) {
            assert.equal(method, "zk_proof", "label must not contain ZK unless method is zk_proof");
          }
        });
      }
    }
  }
});

describe("describeVerdict pinned outputs", () => {
  it("pending", () => {
    assert.deepEqual(describeVerdict("pending", "reexecution_consensus", false), {
      label: "Pending",
      tone: "pending",
      mechanism: "Awaiting replay consensus or the end of its challenge window",
      short: "Awaiting consensus",
    });
  });

  it("disputed", () => {
    assert.deepEqual(describeVerdict("disputed", "reexecution_consensus", true), {
      label: "Disputed",
      tone: "disputed",
      mechanism: "Challenge open, awaiting replay consensus",
      short: "Challenge open",
    });
  });

  it("expired_unverified with challenge", () => {
    assert.deepEqual(describeVerdict("expired_unverified", null, true), {
      label: "Expired, unverified",
      tone: "expired",
      mechanism: "Challenge expired without a replay consensus. Both bonds returned.",
      short: "No consensus reached",
    });
  });

  it("expired_unverified without challenge", () => {
    assert.deepEqual(describeVerdict("expired_unverified", null, false), {
      label: "Expired, unverified",
      tone: "expired",
      mechanism: "Window closed with a mismatch reported but no quorum. Bond returned.",
      short: "No consensus reached",
    });
  });

  it("verified by window_elapsed (verified by default, neutral tone)", () => {
    const res = describeVerdict("verified", "window_elapsed", false);
    assert.deepEqual(res, {
      label: "Verified by default",
      tone: "neutral",
      mechanism: "Unchallenged when its window closed. Not replayed to quorum.",
      short: "Window elapsed, not replayed",
    });
    assert.notEqual(res.tone, "verified");
  });

  it("verified with zk_proof", () => {
    assert.deepEqual(describeVerdict("verified", "zk_proof", false), {
      label: "Verified",
      tone: "verified",
      mechanism: "Cryptographic ZK proof",
      short: "ZK proof",
    });
  });

  it("verified with reexecution_consensus", () => {
    assert.deepEqual(describeVerdict("verified", "reexecution_consensus", true), {
      label: "Verified",
      tone: "verified",
      mechanism: "Bonded re-execution consensus, not a cryptographic proof",
      short: "Re-execution consensus",
    });
  });

  it("verified with unmirrored method (null / undefined)", () => {
    assert.deepEqual(describeVerdict("verified", null, false), {
      label: "Verified",
      tone: "verified",
      mechanism: "Finalized on-chain",
      short: "Finalized on-chain",
    });
    assert.deepEqual(describeVerdict("verified", undefined, false), {
      label: "Verified",
      tone: "verified",
      mechanism: "Finalized on-chain",
      short: "Finalized on-chain",
    });
  });

  it("slashed with zk_proof", () => {
    assert.deepEqual(describeVerdict("slashed", "zk_proof", true), {
      label: "Slashed",
      tone: "slashed",
      mechanism: "Cryptographic ZK proof",
      short: "ZK proof",
    });
  });

  it("slashed with reexecution_consensus", () => {
    assert.deepEqual(describeVerdict("slashed", "reexecution_consensus", true), {
      label: "Slashed",
      tone: "slashed",
      mechanism: "Bonded re-execution consensus, not a cryptographic proof",
      short: "Re-execution consensus",
    });
  });

  it("slashed with window_elapsed or null", () => {
    assert.deepEqual(describeVerdict("slashed", "window_elapsed", false), {
      label: "Slashed",
      tone: "slashed",
      mechanism: "Finalized on-chain",
      short: "Finalized on-chain",
    });
    assert.deepEqual(describeVerdict("slashed", null, false), {
      label: "Slashed",
      tone: "slashed",
      mechanism: "Finalized on-chain",
      short: "Finalized on-chain",
    });
  });
});
