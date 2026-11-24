const STROOPS_PER_XLM = 10_000_000;

/** Formats an amount in stroops (1 XLM = 10,000,000 stroops) as an XLM string, e.g.
 * "15000000" -> "1.5". Negative amounts get a single leading minus. A string must be a
 * base-10 integer; a number must be finite and is truncated toward zero. Anything else
 * throws a RangeError ("Invalid stroops amount: ...") rather than showing a made-up amount. */
export function stroopsToXlm(stroops: string | number): string {
  const valid = typeof stroops === "string" ? /^-?\d+$/.test(stroops) : Number.isFinite(stroops);
  if (!valid) {
    // JSON.stringify would print NaN and Infinity as "null".
    const shown = typeof stroops === "string" ? JSON.stringify(stroops) : String(stroops);
    throw new RangeError(`Invalid stroops amount: ${shown}`);
  }
  const n = typeof stroops === "string" ? BigInt(stroops) : BigInt(Math.trunc(stroops));
  const negative = n < BigInt(0);
  const abs = negative ? -n : n;
  const whole = abs / BigInt(STROOPS_PER_XLM);
  const frac = abs % BigInt(STROOPS_PER_XLM);
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "");
  const formatted = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${formatted}` : formatted;
}

export function truncateMiddle(value: string, head = 6, tail = 6): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

/** Formats a timestamp relative to now (e.g. "3 minutes ago", "in 1 hour").
 * Degrades gracefully to "\u2014" on invalid dates and never throws.
 * Avoids impossible boundary values (such as "60 minutes" or "24 hours")
 * by rolling over to the next larger unit when rounding reaches it. */
export function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "\u2014";
  const diffMs = t - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const sign = Math.sign(diffSec) || 1;
  const abs = Math.abs(diffSec);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, secondsInUnit] of units) {
    if (abs >= secondsInUnit || unit === "second") {
      const rounded = Math.round(abs / secondsInUnit);
      if (unit === "minute" && rounded >= 60) {
        return rtf.format(sign * Math.round(abs / 3600), "hour");
      }
      if (unit === "hour" && rounded >= 24) {
        return rtf.format(sign * Math.round(abs / 86400), "day");
      }
      if (unit === "day" && rounded >= 30) {
        return rtf.format(sign * Math.round(abs / 2592000), "month");
      }
      return rtf.format(sign * rounded, unit);
    }
  }
  return rtf.format(diffSec, "second");
}

/** Formats remaining time until a deadline (e.g. "59m 59s remaining").
 * Returns "window closed" when the deadline is in the past.
 * Degrades gracefully to "\u2014" on invalid dates and never throws. */
export function formatCountdown(deadlineIso: string): string {
  const t = new Date(deadlineIso).getTime();
  if (Number.isNaN(t)) return "\u2014";
  const ms = t - Date.now();
  if (ms <= 0) return "window closed";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m remaining`;
  if (m > 0) return `${m}m ${s}s remaining`;
  return `${s}s remaining`;
}

export function windowDeadlineIso(submittedAtIso: string, windowSeconds: number): string {
  return new Date(new Date(submittedAtIso).getTime() + windowSeconds * 1000).toISOString();
}

export type XlmAmountResult =
  | { ok: true; stroops: bigint }
  | { ok: false; reason: string };

/** Parses an XLM amount a person typed, and says why when it cannot.
 *
 * Accepted forms: `5`, `5.5`, `.5` and `1.` — digits with an optional dot and
 * at most 7 decimal places. Commas are rejected rather than guessed at:
 * whether `1,5` means one and a half or fifteen hundred depends on locale,
 * and a wrong guess changes a bond amount tenfold. */
export function parseXlmAmount(input: string): XlmAmountResult {
  const value = input.trim();
  if (value === "") {
    return { ok: false, reason: "Enter an amount." };
  }
  if (value.includes(",")) {
    return { ok: false, reason: "Use a dot for decimals and no thousands separators." };
  }
  if (value.startsWith("-")) {
    return { ok: false, reason: "The amount must be positive." };
  }
  if (/^(?:\d+\.\d{8,}|\.\d{8,})$/.test(value)) {
    return { ok: false, reason: "Use at most 7 decimal places." };
  }
  if (!/^(?:\d+(?:\.\d{0,7})?|\.\d{1,7})$/.test(value)) {
    return { ok: false, reason: "Enter a number, like 5 or 0.5." };
  }
  const [whole = "", frac = ""] = value.split(".");
  // ".5".split(".") gives ["", "5"]; BigInt("") happens to be 0n, but say it.
  const stroops = BigInt(whole || "0") * BigInt(STROOPS_PER_XLM) + BigInt(frac.padEnd(7, "0"));
  if (stroops <= BigInt(0)) {
    return { ok: false, reason: "The amount must be more than zero." };
  }
  return { ok: true, stroops };
}

/** Parses an XLM amount a person typed into stroops. Null when it is not a
 * positive amount with at most 7 decimal places — so a form can say so,
 * instead of a number conversion throwing somewhere downstream. Accepts the
 * same forms as [parseXlmAmount], which also says why an input was rejected. */
export function xlmToStroops(input: string): bigint | null {
  const result = parseXlmAmount(input);
  return result.ok ? result.stroops : null;
}

/** "10 minutes", "1 hour", "24 hours" — for windows and waits. */
export function formatDuration(seconds: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

/** Basis points as a percentage: 500 -> "5%", 6600 -> "66%", 1250 -> "12.5%". */
export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toString()}%`;
}

const CONTRACT_ERROR_DESCRIPTIONS: Record<string, string> = {
  BondTooLow: "The bond amount is below the required minimum for this escrow value.",
  InvalidEscrowValue: "The declared escrow value must be greater than zero.",
  ChallengeWindowClosed:
    "The challenge window for this submission has closed, so it can no longer be challenged.",
  ChallengeAlreadyOpen: "A challenge has already been opened for this submission.",
  SubmissionNotFound: "The contract has no record of this submission.",
  InvalidAmount: "The amount must be greater than zero and cannot exceed available stake.",
  StakeLockedByOpenAttestation:
    "Stake is locked while the re-executor has open attestations. None of it can be withdrawn until those submissions settle.",
  InvalidOutputHash: "The claimed output hash cannot be all zeros; that value is reserved for \"no output\".",
  VoteContradictsHash: "The vote disagrees with the output hash it reports.",
  AgentCannotAttest: "The agent that made a submission cannot vote on it.",
  AgentCannotChallenge: "The agent that made a submission cannot challenge it.",
  ConsensusAlreadyReached:
    "Re-executors have already decided this submission, so it can no longer be challenged. It settles when it is finalized.",
  ReexecutorNotActive:
    "This account is not an active re-executor or its stake is below the minimum threshold.",
};

/** Plain-language explanation for contract error names a dashboard user can trigger. */
export function describeContractError(name: string): string | null {
  if (Object.hasOwn(CONTRACT_ERROR_DESCRIPTIONS, name)) {
    return CONTRACT_ERROR_DESCRIPTIONS[name];
  }
  return null;
}

