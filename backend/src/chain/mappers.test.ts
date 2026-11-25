import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fromChainVerdict,
  fromChainResolution,
  fromChainResolutionMethod,
  challengeResolutionMethod,
  toChainTaskType,
  sha256Bytes,
  hex,
  bufFromHex,
} from "./mappers.js";

describe("fromChainVerdict", () => {
  const cases = [
    { name: "Verified", expected: "verified" },
    { name: "Disputed", expected: "disputed" },
    { name: "Slashed", expected: "slashed" },
    { name: "ExpiredUnverified", expected: "expired_unverified" },
  ] as const;

  for (const { name, expected } of cases) {
    it(`maps ${name} in {tag, values} shape to "${expected}"`, () => {
      assert.equal(fromChainVerdict({ tag: name, values: undefined }), expected);
    });

    it(`maps ${name} in [name] shape to "${expected}"`, () => {
      assert.equal(fromChainVerdict([name]), expected);
    });

    it(`maps ${name} in "name" string shape to "${expected}"`, () => {
      assert.equal(fromChainVerdict(name), expected);
    });
  }
});

describe("fromChainResolution", () => {
  const cases = [
    { name: "Upheld", expected: "upheld" },
    { name: "Rejected", expected: "rejected" },
    { name: "None", expected: null },
  ] as const;

  for (const { name, expected } of cases) {
    it(`maps ${name} in {tag, values} shape to ${JSON.stringify(expected)}`, () => {
      assert.equal(fromChainResolution({ tag: name, values: undefined }), expected);
    });

    it(`maps ${name} in [name] shape to ${JSON.stringify(expected)}`, () => {
      assert.equal(fromChainResolution([name]), expected);
    });

    it(`maps ${name} in "name" string shape to ${JSON.stringify(expected)}`, () => {
      assert.equal(fromChainResolution(name), expected);
    });
  }
});

describe("fromChainResolutionMethod", () => {
  const cases = [
    { name: "ReexecutionConsensus", expected: "reexecution_consensus" },
    { name: "WindowElapsed", expected: "window_elapsed" },
    { name: "ZkProof", expected: "zk_proof" },
    { name: "None", expected: null },
  ] as const;

  for (const { name, expected } of cases) {
    it(`maps ${name} in {tag, values} shape to ${JSON.stringify(expected)}`, () => {
      assert.equal(fromChainResolutionMethod({ tag: name, values: undefined }), expected);
    });

    it(`maps ${name} in [name] shape to ${JSON.stringify(expected)}`, () => {
      assert.equal(fromChainResolutionMethod([name]), expected);
    });

    it(`maps ${name} in "name" string shape to ${JSON.stringify(expected)}`, () => {
      assert.equal(fromChainResolutionMethod(name), expected);
    });
  }
});

describe("toChainTaskType", () => {
  it('maps "deterministic" to { tag: "Deterministic", values: undefined }', () => {
    assert.deepEqual(toChainTaskType("deterministic"), {
      tag: "Deterministic",
      values: undefined,
    });
  });

  it('maps "retrieval" to { tag: "Retrieval", values: undefined }', () => {
    assert.deepEqual(toChainTaskType("retrieval"), {
      tag: "Retrieval",
      values: undefined,
    });
  });

  it('maps "unverifiable" to { tag: "Unverifiable", values: undefined }', () => {
    assert.deepEqual(toChainTaskType("unverifiable"), {
      tag: "Unverifiable",
      values: undefined,
    });
  });
});

describe("challengeResolutionMethod", () => {
  it("maps ReexecutionConsensus to reexecution_consensus", () => {
    assert.equal(challengeResolutionMethod({ tag: "ReexecutionConsensus", values: undefined }), "reexecution_consensus");
    assert.equal(challengeResolutionMethod(["ReexecutionConsensus"]), "reexecution_consensus");
  });

  it("maps ZkProof to zk_proof", () => {
    assert.equal(challengeResolutionMethod({ tag: "ZkProof", values: undefined }), "zk_proof");
  });

  it("rejects WindowElapsed, None, or unknown variants as null", () => {
    assert.equal(challengeResolutionMethod({ tag: "WindowElapsed", values: undefined }), null);
    assert.equal(challengeResolutionMethod({ tag: "None", values: undefined }), null);
    assert.equal(challengeResolutionMethod("Unknown"), null);
  });
});

describe("sha256Bytes", () => {
  it("computes expected hash for empty string", () => {
    const emptyHash = sha256Bytes("");
    assert.equal(emptyHash.length, 32);
    assert.equal(
      hex(emptyHash),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it('computes expected hash for "abc"', () => {
    const abcHash = sha256Bytes("abc");
    assert.equal(abcHash.length, 32);
    assert.equal(
      hex(abcHash),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("yields identical output for Buffer input and string input", () => {
    const strInput = "hello world from verity";
    const bufInput = Buffer.from(strInput, "utf8");
    assert.deepEqual(sha256Bytes(bufInput), sha256Bytes(strInput));
  });
});

describe("hex and bufFromHex", () => {
  it("round-trips for valid even-length lowercase hex (00ff10)", () => {
    const raw = "00ff10" + "00".repeat(29);
    assert.equal(raw.length, 64);
    const buf = bufFromHex(raw);
    assert.equal(buf.length, 32);
    assert.equal(hex(buf), raw);
  });
});
