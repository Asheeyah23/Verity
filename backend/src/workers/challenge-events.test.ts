import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { challengeClosure, challengeResolutionMethod } from "./challenge-events.js";

// The three shapes a fieldless contract enum arrives in, depending on the path.
const shapes = (name: string): unknown[] => [{ tag: name, values: undefined }, [name], name];

describe("challengeClosure for challenge_expired", () => {
  it("closes the challenge as expired, with no method", () => {
    assert.deepEqual(challengeClosure("challenge_expired", undefined), {
      resolution: "expired",
      resolution_method: null,
    });
  });

  it("does not read the payload, whatever it holds", () => {
    const payloads: unknown[] = [
      null,
      {},
      "Upheld",
      { resolution: { tag: "Upheld", values: undefined }, method: ["ReexecutionConsensus"] },
      { resolution: ["Rejected"], method: ["ZkProof"] },
    ];
    for (const payload of payloads) {
      assert.deepEqual(challengeClosure("challenge_expired", payload), {
        resolution: "expired",
        resolution_method: null,
      });
    }
  });
});

describe("challengeClosure for challenge_resolved", () => {
  for (const [tag, expected] of [
    ["Upheld", "upheld"],
    ["Rejected", "rejected"],
  ] as const) {
    it(`records ${tag} by re-execution consensus, in every enum shape`, () => {
      for (const resolution of shapes(tag)) {
        for (const method of shapes("ReexecutionConsensus")) {
          assert.deepEqual(challengeClosure("challenge_resolved", { resolution, method }), {
            resolution: expected,
            resolution_method: "reexecution_consensus",
          });
        }
      }
    });
  }

  it("records the zk_proof method when the contract reports it", () => {
    assert.deepEqual(
      challengeClosure("challenge_resolved", { resolution: ["Upheld"], method: ["ZkProof"] }),
      { resolution: "upheld", resolution_method: "zk_proof" },
    );
  });

  it("never turns a resolution it does not know into an expiry", () => {
    for (const resolution of [...shapes("None"), ...shapes("Whatever"), undefined, null, 7]) {
      assert.equal(
        challengeClosure("challenge_resolved", { resolution, method: ["ReexecutionConsensus"] })
          .resolution,
        null,
      );
    }
  });

  it("leaves both fields null for a payload that is not an object", () => {
    for (const payload of [undefined, null, "Upheld", 3]) {
      assert.deepEqual(challengeClosure("challenge_resolved", payload), {
        resolution: null,
        resolution_method: null,
      });
    }
  });
});

describe("challengeResolutionMethod", () => {
  it("keeps the two methods that resolve a challenge", () => {
    for (const method of shapes("ReexecutionConsensus")) {
      assert.equal(challengeResolutionMethod(method), "reexecution_consensus");
    }
    for (const method of shapes("ZkProof")) {
      assert.equal(challengeResolutionMethod(method), "zk_proof");
    }
  });

  it("is null for a window that elapsed, for None and for anything else", () => {
    for (const name of ["WindowElapsed", "None", "Whatever"]) {
      for (const method of shapes(name)) assert.equal(challengeResolutionMethod(method), null);
    }
    assert.equal(challengeResolutionMethod(undefined), null);
  });
});
