import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePage, PAGE_SIZE, MAX_PAGE } from "./paging.ts";

describe("paging constants", () => {
  it("exports PAGE_SIZE as 25", () => {
    assert.equal(PAGE_SIZE, 25);
  });

  it("exports MAX_PAGE correctly calculated", () => {
    assert.equal(MAX_PAGE, Math.floor(Number.MAX_SAFE_INTEGER / PAGE_SIZE) + 1);
  });
});

describe("parsePage edge cases", () => {
  it('rejects "0"', () => {
    assert.equal(parsePage("0"), 1);
  });

  it('rejects leading zeros "01"', () => {
    assert.equal(parsePage("01"), 1);
    assert.equal(parsePage("007"), 1);
  });

  it('rejects scientific notation "1e3"', () => {
    assert.equal(parsePage("1e3"), 1);
    assert.equal(parsePage("2e1"), 1);
  });

  it('rejects negative numbers "-1"', () => {
    assert.equal(parsePage("-1"), 1);
    assert.equal(parsePage("-25"), 1);
  });

  it("rejects non-numeric and malformed strings", () => {
    assert.equal(parsePage(""), 1);
    assert.equal(parsePage("abc"), 1);
    assert.equal(parsePage("+1"), 1);
    assert.equal(parsePage("1.5"), 1);
    assert.equal(parsePage(" 1 "), 1);
    assert.equal(parsePage(undefined), 1);
  });

  it("handles arrays", () => {
    assert.equal(parsePage(["1"]), 1);
    assert.equal(parsePage(["5"]), 5);
    assert.equal(parsePage(["5", "10"]), 5);
    assert.equal(parsePage(["0"]), 1);
    assert.equal(parsePage(["01"]), 1);
    assert.equal(parsePage(["1e3"]), 1);
    assert.equal(parsePage(["-1"]), 1);
    assert.equal(parsePage([]), 1);
    assert.equal(parsePage(["abc"]), 1);
  });

  it("parses valid positive integers", () => {
    assert.equal(parsePage("1"), 1);
    assert.equal(parsePage("2"), 2);
    assert.equal(parsePage("25"), 25);
    assert.equal(parsePage("100"), 100);
  });

  it("handles the MAX_PAGE boundary", () => {
    assert.equal(parsePage(String(MAX_PAGE)), MAX_PAGE);
    assert.equal(parsePage(String(MAX_PAGE - 1)), MAX_PAGE - 1);
    assert.equal(parsePage(String(MAX_PAGE + 1)), 1);
    assert.equal(parsePage(String(Number.MAX_SAFE_INTEGER)), 1);
    assert.equal(parsePage("999999999999999999999"), 1);
  });
});
