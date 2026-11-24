import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bpsToPercent,
  challengeWindowState,
  formatCountdown,
  formatDuration,
  formatRelativeTime,
  recordedWindowDeadlineIso,
  stroopsToXlm,
  truncateMiddle,
  windowDeadlineIso,
  xlmToStroops,
} from "./format.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

describe("xlmToStroops", () => {
  const cases = [
    ["1.5", 15000000n],
    ["0.0000001", 1n],
    [" 12 ", 120000000n],
    ["00012", 120000000n],
    ["1.0000000", 10000000n],
    ["99999999999", 999999999990000000n],
    ["1.12345678", null],
    ["", null],
    ["0", null],
    ["0.0", null],
    ["-1", null],
    ["1,000", null],
    ["1e3", null],
    ["+1", null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(xlmToStroops(input), expected);
    });
  }

  for (const input of ["1.5", "0.0000001", "123"]) {
    it(`round trips ${input} through stroopsToXlm`, () => {
      assert.equal(stroopsToXlm(xlmToStroops(input).toString()), input);
    });
  }
});

describe("stroopsToXlm", () => {
  const cases = [
    ["0", "0"],
    ["1", "0.0000001"],
    ["10000000", "1"],
    ["15000000", "1.5"],
    ["9999999", "0.9999999"],
    ["12345678901234567890", "1234567890123.456789"],
    [15000000, "1.5"],
    [1.9, "0.0000001"],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(stroopsToXlm(input), expected);
    });
  }
});

describe("truncateMiddle", () => {
  const cases = [
    [["123456789012345"], "123456789012345"],
    [["1234567890123456"], "123456...123456"],
    [["ABCDEFGHIJKLMNOP", 2, 2], "AB...OP"],
  ];
  for (const [args, expected] of cases) {
    it(`${JSON.stringify(args)} -> ${expected}`, () => {
      assert.equal(truncateMiddle(...args), expected);
    });
  }
});

describe("formatDuration", () => {
  const cases = [
    [3600, "1 hour"],
    [7200, "2 hours"],
    [86400, "24 hours"],
    [60, "1 minute"],
    [600, "10 minutes"],
    [90, "90 seconds"],
    [1, "1 second"],
    [3601, "3601 seconds"],
    [0, "0 hours"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      assert.equal(formatDuration(input), expected);
    });
  }
});

describe("bpsToPercent", () => {
  const cases = [
    [500, "5%"],
    [6600, "66%"],
    [1250, "12.5%"],
    [0, "0%"],
    [1, "0.01%"],
    [10000, "100%"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      assert.equal(bpsToPercent(input), expected);
    });
  }
});

describe("windowDeadlineIso", () => {
  const cases = [
    [["2026-01-01T00:00:00.000Z", 600], "2026-01-01T00:10:00.000Z"],
    [["2026-01-01T00:00:00Z", 0], "2026-01-01T00:00:00.000Z"],
  ];
  for (const [args, expected] of cases) {
    it(`${JSON.stringify(args)} -> ${expected}`, () => {
      assert.equal(windowDeadlineIso(...args), expected);
    });
  }
});

describe("recordedWindowDeadlineIso", () => {
  it("returns null when challenge_window_s is 0 (not yet read from contract)", () => {
    assert.equal(recordedWindowDeadlineIso("2026-01-01T00:00:00.000Z", 0), null);
  });

  it("returns null when challenge_window_s is negative", () => {
    assert.equal(recordedWindowDeadlineIso("2026-01-01T00:00:00.000Z", -10), null);
  });

  it("returns the computed ISO deadline when challenge_window_s is positive", () => {
    assert.equal(
      recordedWindowDeadlineIso("2026-01-01T00:00:00.000Z", 600),
      "2026-01-01T00:10:00.000Z",
    );
  });
});

describe("challengeWindowState", () => {
  it("returns unknown when deadlineIso is null", () => {
    assert.equal(challengeWindowState(null, NOW), "unknown");
  });

  it("returns open strictly before the deadline", () => {
    assert.equal(challengeWindowState(at(1), NOW), "open");
    assert.equal(challengeWindowState(at(10 * MIN), NOW), "open");
  });

  it("returns closed at or after the deadline", () => {
    assert.equal(challengeWindowState(at(0), NOW), "closed");
    assert.equal(challengeWindowState(at(-SEC), NOW), "closed");
  });

  it("returns closed on an unparseable deadline string", () => {
    assert.equal(challengeWindowState("not-a-date", NOW), "closed");
  });

  it("never classifies an unrecorded window (challenge_window_s = 0) as closed", () => {
    // Draft created 1 hour before NOW with challenge_window_s still 0.
    const deadline = recordedWindowDeadlineIso(at(-HOUR), 0);
    assert.equal(deadline, null);
    assert.equal(challengeWindowState(deadline, NOW), "unknown");
    // Once the indexer records the on-chain timestamp and window, it becomes open.
    const recorded = recordedWindowDeadlineIso(at(-MIN), 600);
    assert.equal(challengeWindowState(recorded, NOW), "open");
  });
});

describe("formatCountdown", () => {
  const cases = [
    [-1000, "window closed"],
    [0, "window closed"],
    [1, "0s remaining"],
    [999, "0s remaining"],
    [45 * SEC, "45s remaining"],
    [125 * SEC, "2m 5s remaining"],
    [HOUR, "1h 0m remaining"],
    [3725 * SEC, "1h 2m remaining"],
    [48 * HOUR, "48h 0m remaining"],
  ];
  for (const [offsetMs, expected] of cases) {
    it(`${offsetMs} ms from now -> ${expected}`, (t) => {
      t.mock.method(Date, "now", () => NOW);
      assert.equal(formatCountdown(at(offsetMs)), expected);
    });
  }
});

describe("formatRelativeTime", () => {
  const cases = [
    [0, "now"],
    [30 * SEC, "in 30 seconds"],
    [-30 * SEC, "30 seconds ago"],
    [-MIN, "1 minute ago"],
    [HOUR, "in 1 hour"],
    [-HOUR, "1 hour ago"],
    [DAY, "tomorrow"],
    [-DAY, "yesterday"],
    [2 * DAY, "in 2 days"],
  ];
  for (const [offsetMs, expected] of cases) {
    it(`${offsetMs} ms from now -> ${expected}`, (t) => {
      t.mock.method(Date, "now", () => NOW);
      assert.equal(formatRelativeTime(at(offsetMs)), expected);
    });
  }
});
