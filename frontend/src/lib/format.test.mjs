import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bpsToPercent,
  challengeWindowState,
  formatCountdown,
  formatDuration,
  formatRelativeTime,
  recordedWindowDeadlineIso,
  formatUnits,
  mapTrustlineError,
  parseUnits,
  resolveBondAsset,
  stroopsToXlm,
  truncateMiddle,
  trustlineNote,
  windowDeadlineIso,
  xlmToStroops,
} from "./format.ts";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

describe("formatUnits", () => {
  const xlmCases = [
    ["0", "0 XLM"],
    ["1", "0.0000001 XLM"],
    ["10000000", "1 XLM"],
    ["15000000", "1.5 XLM"],
    ["-15000000", "-1.5 XLM"],
    ["-1", "-0.0000001 XLM"],
    ["-0", "0 XLM"],
    ["9999999", "0.9999999 XLM"],
    ["12345678901234567890", "1234567890123.456789 XLM"],
    [15000000, "1.5 XLM"],
    [-15000000, "-1.5 XLM"],
    [15000000n, "1.5 XLM"],
    [-15000000n, "-1.5 XLM"],
  ];
  for (const [input, expected] of xlmCases) {
    it(`7-decimal XLM: ${String(input)} -> ${expected}`, () => {
      assert.equal(formatUnits(input, 7, "XLM"), expected);
    });
  }

  const usdcCases = [
    ["0", "0 USDC"],
    ["1", "0.0000001 USDC"],
    ["10000000", "1 USDC"],
    ["15000000", "1.5 USDC"],
    ["250000000", "25 USDC"],
    ["-15000000", "-1.5 USDC"],
    ["-250000000", "-25 USDC"],
    ["9999999", "0.9999999 USDC"],
    [50000000, "5 USDC"],
    [-50000000, "-5 USDC"],
  ];
  for (const [input, expected] of usdcCases) {
    it(`7-decimal USDC: ${String(input)} -> ${expected}`, () => {
      assert.equal(formatUnits(input, 7, "USDC"), expected);
    });
  }

  it("formats without a symbol when symbol is omitted", () => {
    assert.equal(formatUnits("15000000", 7), "1.5");
    assert.equal(formatUnits("-15000000", 7), "-1.5");
    assert.equal(formatUnits("1500000", 6, "USDC"), "1.5 USDC");
    assert.equal(formatUnits("42", 0, "TOKEN"), "42 TOKEN");
  });

  for (const bad of ["", "abc", "1.5", "10_000", "1e7", "12 USDC", "--1", "+1", NaN, Infinity, -Infinity]) {
    it(`rejects malformed amount ${String(bad)}`, () => {
      assert.throws(() => formatUnits(bad, 7, "USDC"), RangeError);
    });
  }

  for (const badDecimals of [-1, 1.5, NaN, Infinity]) {
    it(`rejects invalid decimals ${String(badDecimals)}`, () => {
      assert.throws(() => formatUnits("10000000", badDecimals, "USDC"), RangeError);
    });
  }
});

describe("parseUnits", () => {
  const valid7DecimalCases = [
    ["1.5", 15000000n],
    ["0.0000001", 1n],
    [" 12 ", 120000000n],
    ["00012", 120000000n],
    ["1.0000000", 10000000n],
    [".5", 5000000n],
    ["1.", 10000000n],
    ["99999999999", 999999999990000000n],
  ];
  for (const [input, expected] of valid7DecimalCases) {
    it(`parses 7-decimal XLM/USDC ${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(parseUnits(input, 7), expected);
    });
  }

  const invalid7DecimalCases = [
    "1.12345678",
    "",
    "   ",
    "0",
    "0.0",
    ".0",
    "-1",
    "-0.5",
    "-0.0000001",
    "1,000",
    "1e3",
    "+1",
    "abc",
    "1.2.3",
    ".",
    "1.5 USDC",
    "1.5 XLM",
  ];
  for (const input of invalid7DecimalCases) {
    it(`rejects negative or malformed 7-decimal input ${JSON.stringify(input)}`, () => {
      assert.equal(parseUnits(input, 7), null);
    });
  }

  it("respects custom decimal precision", () => {
    assert.equal(parseUnits("1.5", 6), 1500000n);
    assert.equal(parseUnits("0.123456", 6), 123456n);
    assert.equal(parseUnits("0.1234567", 6), null);
    assert.equal(parseUnits("42", 0), 42n);
    assert.equal(parseUnits("42.5", 0), null);
  });

  for (const input of ["1.5", "0.0000001", "123"]) {
    it(`round-trips ${input} for 7-decimal XLM and USDC`, () => {
      const units = parseUnits(input, 7);
      assert.equal(formatUnits(units.toString(), 7, "XLM"), `${input} XLM`);
      assert.equal(formatUnits(units.toString(), 7, "USDC"), `${input} USDC`);
    });
  }
});

describe("resolveBondAsset and trustline helpers", () => {
  it("normalises 'native' and missing values to 7-decimal XLM", () => {
    assert.deepEqual(resolveBondAsset("native"), { contract_id: "", symbol: "XLM", decimals: 7 });
    assert.deepEqual(resolveBondAsset(undefined), { contract_id: "", symbol: "XLM", decimals: 7 });
    assert.deepEqual(
      resolveBondAsset({ contract_id: "CUSDC", symbol: "USDC", decimals: 7 }),
      { contract_id: "CUSDC", symbol: "USDC", decimals: 7 }
    );
  });

  it("maps trustline relay failures to plain trustline guidance", () => {
    const note = trustlineNote("USDC");
    assert.match(note, /trustline to USDC/);
    assert.equal(
      mapTrustlineError(new Error("HostError: Error(Contract, #13) trustline is missing"), "USDC"),
      note
    );
    assert.equal(
      mapTrustlineError(new Error("The network rejected the transaction (op_no_trust)."), "USDC"),
      note
    );
    assert.equal(
      mapTrustlineError(new Error("Some other error"), "USDC"),
      "Some other error"
    );
  });
});

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
