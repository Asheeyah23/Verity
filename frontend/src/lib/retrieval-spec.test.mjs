import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateRetrievalSpec } from "./retrieval-spec.ts";

describe("validateRetrievalSpec", () => {
  it("rejects non-object values", () => {
    const nonObjects = [null, undefined, 42, "string", true, false, [1, 2], []];
    for (const val of nonObjects) {
      assert.throws(
        () => validateRetrievalSpec(val),
        /The request spec must be a JSON object/
      );
    }
  });

  it("rejects missing url", () => {
    assert.throws(
      () => validateRetrievalSpec({}),
      /The request spec needs a "url" starting with http:\/\/ or https:\/\//
    );
    assert.throws(
      () => validateRetrievalSpec({ url: 123 }),
      /The request spec needs a "url" starting with http:\/\/ or https:\/\//
    );
    assert.throws(
      () => validateRetrievalSpec({ url: null }),
      /The request spec needs a "url" starting with http:\/\/ or https:\/\//
    );
  });

  it("rejects invalid URLs", () => {
    assert.throws(
      () => validateRetrievalSpec({ url: "not-a-url" }),
      /"not-a-url" is not a valid URL/
    );
    assert.throws(
      () => validateRetrievalSpec({ url: "://missing-scheme" }),
      /is not a valid URL/
    );
  });

  it("rejects javascript: and non-http(s) URLs", () => {
    assert.throws(
      () => validateRetrievalSpec({ url: "javascript:alert(1)" }),
      /The "url" must start with http:\/\/ or https:\/\//
    );
    assert.throws(
      () => validateRetrievalSpec({ url: "ftp://example.com/file.txt" }),
      /The "url" must start with http:\/\/ or https:\/\//
    );
    assert.throws(
      () => validateRetrievalSpec({ url: "file:///etc/passwd" }),
      /The "url" must start with http:\/\/ or https:\/\//
    );
    assert.throws(
      () => validateRetrievalSpec({ url: "data:text/plain;base64,aGVsbG8=" }),
      /The "url" must start with http:\/\/ or https:\/\//
    );
  });

  it("rejects pointer without a leading /", () => {
    assert.throws(
      () => validateRetrievalSpec({ url: "https://example.com", pointer: "field" }),
      /The "pointer" must be a JSON Pointer string: "" for the whole document, or starting with "\/"/
    );
    assert.throws(
      () => validateRetrievalSpec({ url: "https://example.com", pointer: "network_passphrase" }),
      /The "pointer" must be a JSON Pointer string/
    );
    assert.throws(
      () => validateRetrievalSpec({ url: "https://example.com", pointer: 123 }),
      /The "pointer" must be a JSON Pointer string/
    );
  });

  it('accepts "" pointer for the whole document', () => {
    assert.doesNotThrow(() =>
      validateRetrievalSpec({ url: "https://example.com/data.json", pointer: "" })
    );
  });

  it("accepts valid specs with pointer starting with /", () => {
    assert.doesNotThrow(() =>
      validateRetrievalSpec({
        url: "https://horizon-testnet.stellar.org/",
        pointer: "/network_passphrase",
      })
    );
    assert.doesNotThrow(() =>
      validateRetrievalSpec({
        url: "http://api.example.com/items",
        pointer: "/items/0/id",
      })
    );
  });

  it("accepts valid spec without pointer or with pointer undefined", () => {
    assert.doesNotThrow(() =>
      validateRetrievalSpec({ url: "https://example.com" })
    );
    assert.doesNotThrow(() =>
      validateRetrievalSpec({ url: "http://example.com", pointer: undefined })
    );
  });
});
