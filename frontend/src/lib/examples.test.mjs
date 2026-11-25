import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, parseJsonOrText } from "./canonical.ts";
import { EXAMPLES, EXAMPLE_LIST, generateExampleEscrowRef } from "./examples.ts";
import { validateRetrievalSpec } from "./retrieval-spec.ts";

function runDeterministicInNode(functionBody, inputJson) {
  const input = JSON.parse(inputJson);
  const fn = new Function("input", functionBody);
  return fn(input);
}

describe("submission form examples", () => {
  it("lists all three examples with unique ids", () => {
    assert.equal(EXAMPLE_LIST.length, 3);
    const ids = new Set(EXAMPLE_LIST.map((e) => e.id));
    assert.equal(ids.size, 3);
  });

  it("deterministicCorrect output matches running its function on its input", () => {
    const example = EXAMPLES.deterministicCorrect;
    assert.equal(example.taskType, "deterministic");
    assert.equal(example.expectedOutcome, "verified");

    const actual = runDeterministicInNode(example.functionBody, example.input);
    assert.equal(
      canonicalJson(parseJsonOrText(example.output)),
      canonicalJson(actual),
    );
    assert.equal(canonicalJson(actual), '{"doubled":42}');
  });

  it("deterministicWrong output mismatches running its function on its input", () => {
    const example = EXAMPLES.deterministicWrong;
    assert.equal(example.taskType, "deterministic");
    assert.equal(example.expectedOutcome, "slashed");

    const actual = runDeterministicInNode(example.functionBody, example.input);
    assert.notEqual(
      canonicalJson(parseJsonOrText(example.output)),
      canonicalJson(actual),
    );
    assert.equal(canonicalJson(actual), '{"doubled":42}');
    assert.equal(canonicalJson(parseJsonOrText(example.output)), '{"doubled":43}');
    assert.match(example.label, /slash/i);
    assert.match(example.note, /forfeit/i);
  });

  it("retrievalCorrect passes validateRetrievalSpec and canonicalises cleanly", () => {
    const example = EXAMPLES.retrievalCorrect;
    assert.equal(example.taskType, "retrieval");
    assert.equal(example.expectedOutcome, "verified");
    assert.equal(example.functionBody, "");

    const spec = JSON.parse(example.input);
    assert.doesNotThrow(() => validateRetrievalSpec(spec));
    assert.equal(
      canonicalJson(parseJsonOrText(example.output)),
      '"Test SDF Network ; September 2015"',
    );
  });

  it("example labels and notes do not claim anything is simulated", () => {
    for (const example of EXAMPLE_LIST) {
      assert.doesNotMatch(example.label, /simulat|fake|mock/i);
      assert.doesNotMatch(example.note, /simulat|fake|mock/i);
    }
  });
});

describe("generateExampleEscrowRef", () => {
  it("returns demo-<6 hex chars> within the escrow reference limit", () => {
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const ref = generateExampleEscrowRef();
      assert.match(ref, /^demo-[0-9a-f]{6}$/);
      assert.equal(ref.trim(), ref);
      assert.ok(ref.length <= 128);
      seen.add(ref);
    }
    assert.ok(seen.size > 1);
  });
});

describe("validateRetrievalSpec", () => {
  it("accepts http(s) URLs with optional JSON pointers", () => {
    assert.doesNotThrow(() =>
      validateRetrievalSpec({
        url: "https://horizon-testnet.stellar.org/",
        pointer: "/network_passphrase",
      }),
    );
    assert.doesNotThrow(() =>
      validateRetrievalSpec({ url: "https://example.com/data.json" }),
    );
    assert.doesNotThrow(() =>
      validateRetrievalSpec({ url: "http://example.com/data.json", pointer: "" }),
    );
  });

  it("rejects non-objects, bad URLs, non-http(s) protocols, and invalid pointers", () => {
    assert.throws(() => validateRetrievalSpec(null), /JSON object/);
    assert.throws(() => validateRetrievalSpec([]), /JSON object/);
    assert.throws(() => validateRetrievalSpec({}), /"url"/);
    assert.throws(() => validateRetrievalSpec({ url: "not-a-url" }), /not a valid URL/);
    assert.throws(() => validateRetrievalSpec({ url: "javascript:alert(1)" }), /http:\/\/ or https:\/\//);
    assert.throws(() => validateRetrievalSpec({ url: "ftp://example.com/a" }), /http:\/\/ or https:\/\//);
    assert.throws(
      () => validateRetrievalSpec({ url: "https://example.com/", pointer: "no-leading-slash" }),
      /JSON Pointer/,
    );
    assert.throws(
      () => validateRetrievalSpec({ url: "https://example.com/", pointer: 123 }),
      /JSON Pointer/,
    );
  });
});
