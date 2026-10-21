/**
 * Golden vectors for the dashboard's canonical JSON (#85).
 *
 * These vectors must stay identical across the three copies of
 * `canonicalJson` (reexecutor-agent/src/sandbox/canonical.ts,
 * frontend/src/lib/canonical.ts, backend/src/chain/canonical.ts), as
 * CONTRIBUTING.md ("Canonical JSON must stay identical") requires — honest
 * work produces false mismatches the moment one copy drifts. Keep the table
 * in this order and with these values so the suites compare by eye.
 *
 * Keys sort by UTF-16 code unit order, not by locale: "B" before "a", "é"
 * after "z". Do not "improve" the expected values.
 *
 * Run just this file: node --experimental-strip-types --test src/lib/canonical.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { canonicalJson, parseJsonOrText } from "./canonical.ts";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

describe("canonicalJson golden vectors", () => {
  /** @type {Array<[string, unknown, string]>} */
  const vectors = [
    ["undefined", undefined, "null"],
    ["null", null, "null"],
    ["NaN", NaN, "null"],
    ["Infinity", Infinity, "null"],
    ["negative zero", -0, "0"],
    [
      "nested objects and arrays, keys sorted recursively, undefined dropped",
      { b: 1, a: { d: 2, c: [3, { z: 1, y: undefined, x: null }] } },
      '{"a":{"c":[3,{"x":null,"z":1}],"d":2},"b":1}',
    ],
    [
      "code-unit key order: digits before uppercase before lowercase",
      { b: 1, a: 3, B: 2, "10": 1, "9": 2 },
      '{"10":1,"9":2,"B":2,"a":3,"b":1}',
    ],
    ["undefined inside an array becomes null", [undefined, 1, null], "[null,1,null]"],
    ["string with non-ASCII, newline and quotes", 'é \n"x"', '"é \\n\\"x\\""'],
    ["empty object", {}, "{}"],
    ["empty array", [], "[]"],
    ["object whose only key is undefined", { a: undefined }, "{}"],
    ["non-ASCII key sorts after z by code unit", { "é": 1, z: 2, a: 3 }, '{"a":3,"z":2,"é":1}'],
  ];

  for (const [name, input, expected] of vectors) {
    it(name, () => {
      assert.equal(canonicalJson(input), expected);
    });
  }

  it("throws TypeError on a BigInt value", () => {
    assert.throws(() => canonicalJson(1n), TypeError);
    assert.throws(() => canonicalJson({ a: 1n }), TypeError);
  });

  it("hashes to the shared golden digests", () => {
    assert.equal(
      sha256(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: undefined, x: null }] } })),
      "c17610e9170edec56ed86af4e6e110091e79f42f7bc4460eb101ab613aeab138",
    );
    assert.equal(
      sha256(canonicalJson({ b: 1, a: 3, B: 2, "10": 1, "9": 2 })),
      "99158e82efe4e49f542f73bbf83b8c783fa8fe10c452d680ca7a2e3eeb465e37",
    );
  });

  it("emits no whitespace outside string values", () => {
    const out = canonicalJson({ a: [1, 2, { b: "keep  this" }], c: "x y" });
    // Strip string literals, then nothing that remains may be whitespace.
    const outsideStrings = out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    assert.doesNotMatch(outsideStrings, /\s/);
    assert.match(out, /keep {2}this/);
  });

  it("is independent of input key order", () => {
    assert.equal(
      canonicalJson({ a: 1, b: { c: 2, d: 3 } }),
      canonicalJson({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("sorts recursively inside arrays and objects", () => {
    assert.equal(
      canonicalJson([{ b: 1, a: 2 }, { d: { f: 1, e: 2 } }]),
      '[{"a":2,"b":1},{"d":{"e":2,"f":1}}]',
    );
  });
});

describe("parseJsonOrText golden vectors", () => {
  it("parses valid JSON", () => {
    assert.deepEqual(parseJsonOrText('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonOrText("[1, 2,3]"), [1, 2, 3]);
  });

  it("trims before parsing", () => {
    assert.deepEqual(parseJsonOrText('\n\t{"a": [1, 2]}\n'), { a: [1, 2] });
  });

  it("parses JSON scalars", () => {
    assert.equal(parseJsonOrText("42"), 42);
    assert.equal(parseJsonOrText("true"), true);
    assert.equal(parseJsonOrText("null"), null);
    assert.equal(parseJsonOrText('"quoted"'), "quoted");
  });

  it("returns trimmed plain text when JSON parsing fails", () => {
    assert.equal(parseJsonOrText("  hello world  "), "hello world");
    assert.equal(parseJsonOrText("[1,2"), "[1,2");
    assert.equal(parseJsonOrText("{'a':1}"), "{'a':1}");
    assert.equal(parseJsonOrText("undefined"), "undefined");
    assert.equal(parseJsonOrText("007"), "007");
  });

  it("returns the empty string for empty or whitespace-only input", () => {
    assert.equal(parseJsonOrText(""), "");
    assert.equal(parseJsonOrText("   "), "");
  });

  it("composes with canonicalJson the way the submission form uses it", () => {
    assert.equal(canonicalJson(parseJsonOrText('{"b":1,"a":2}')), '{"a":2,"b":1}');
    assert.equal(canonicalJson(parseJsonOrText("  hello  ")), '"hello"');
  });
});
