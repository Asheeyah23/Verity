import type { BondAsset } from "./types";

const DEFAULT_DECIMALS = 7;

export const NATIVE_BOND_ASSET: BondAsset = {
  contract_id: "",
  symbol: "XLM",
  decimals: DEFAULT_DECIMALS,
};

/** Normalises the `/v1/config` `bond_asset` field so both the legacy `"native"`
 * string and the `{ contract_id, symbol, decimals }` object resolve to a concrete asset. */
export function resolveBondAsset(asset?: BondAsset | "native" | null): BondAsset {
  if (!asset || asset === "native") return NATIVE_BOND_ASSET;
  return {
    contract_id: asset.contract_id ?? "",
    symbol: asset.symbol === "native" ? "XLM" : asset.symbol,
    decimals: asset.decimals,
  };
}

/** Formats an integer amount in base units (`10 ** decimals` base units = 1 token)
 * as a decimal string, appending ` ${symbol}` when `symbol` is given.
 * Negative amounts get a single leading minus. A string must be a base-10 integer;
 * a number must be finite and is truncated toward zero. Anything else throws a
 * RangeError rather than showing a made-up amount. */
export function formatUnits(
  amount: string | number | bigint,
  decimals = DEFAULT_DECIMALS,
  symbol?: string
): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`Invalid decimals: ${String(decimals)}`);
  }
  const valid =
    typeof amount === "bigint"
      ? true
      : typeof amount === "string"
        ? /^-?\d+$/.test(amount)
        : Number.isFinite(amount);
  if (!valid) {
    // JSON.stringify would print NaN and Infinity as "null".
    const shown = typeof amount === "string" ? JSON.stringify(amount) : String(amount);
    throw new RangeError(`Invalid stroops amount: ${shown}`);
  }
  const n =
    typeof amount === "bigint"
      ? amount
      : typeof amount === "string"
        ? BigInt(amount)
        : BigInt(Math.trunc(amount));
  const negative = n < BigInt(0);
  const abs = negative ? -n : n;
  const base = BigInt(10) ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = decimals > 0 ? frac.toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  const formatted = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  const signed = negative ? `-${formatted}` : formatted;
  return symbol ? `${signed} ${symbol}` : signed;
}

/** Formats an amount in stroops (7 decimals) as a decimal string, e.g. "15000000" -> "1.5". */
export function stroopsToXlm(stroops: string | number): string {
  return formatUnits(stroops, DEFAULT_DECIMALS);
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

/** Returns the challenge window deadline when `windowSeconds` has been recorded (> 0),
 * or `null` while it is still 0 (not yet read back from the contract). */
export function recordedWindowDeadlineIso(
  submittedAtIso: string,
  windowSeconds: number
): string | null {
  return windowSeconds > 0 ? windowDeadlineIso(submittedAtIso, windowSeconds) : null;
}

export type ChallengeWindowState = "unknown" | "open" | "closed";

/** Classifies a challenge window deadline against `nowMs`.
 * Returns `"unknown"` while the window has not been read from the contract (`null`),
 * `"open"` strictly before the deadline, and `"closed"` at or after it. */
export function challengeWindowState(
  deadlineIso: string | null,
  nowMs: number = Date.now()
): ChallengeWindowState {
  if (deadlineIso === null) return "unknown";
  const deadlineMs = Date.parse(deadlineIso);
  if (Number.isNaN(deadlineMs)) return "closed";
  return nowMs < deadlineMs ? "open" : "closed";
}

export type XlmAmountResult =
  | { ok: true; stroops: bigint }
  | { ok: false; reason: string };

/** Parses a token amount a person typed into base units, and says why when it cannot.
 *
 * Accepted forms: `5`, `5.5`, `.5` and `1.` — digits with an optional dot and
 * at most `decimals` decimal places. Commas are rejected rather than guessed at:
 * whether `1,5` means one and a half or fifteen hundred depends on locale,
 * and a wrong guess changes a bond amount tenfold. */
export function parseXlmAmount(input: string, decimals = DEFAULT_DECIMALS): XlmAmountResult {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`Invalid decimals: ${String(decimals)}`);
  }
  if (typeof input !== "string") {
    return { ok: false, reason: "Enter an amount." };
  }
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
  if (decimals === 0) {
    if (/^(?:\d+\.\d+|\.\d+)$/.test(value)) {
      return { ok: false, reason: "Use at most 0 decimal places." };
    }
    if (!/^\d+\.?$/.test(value)) {
      return { ok: false, reason: "Enter a whole number, like 5." };
    }
  } else {
    const tooManyDecimals = new RegExp(`^(?:\\d+\\.\\d{${decimals + 1},}|\\.\\d{${decimals + 1},})$`);
    if (tooManyDecimals.test(value)) {
      return {
        ok: false,
        reason: `Use at most ${decimals} decimal place${decimals === 1 ? "" : "s"}.`,
      };
    }
    const validNumber = new RegExp(`^(?:\\d+(?:\\.\\d{0,${decimals}})?|\\.\\d{1,${decimals}})$`);
    if (!validNumber.test(value)) {
      return { ok: false, reason: "Enter a number, like 5 or 0.5." };
    }
  }
  const [whole = "", frac = ""] = value.split(".");
  // ".5".split(".") gives ["", "5"]; BigInt("") happens to be 0n, but say it.
  const base = BigInt(10) ** BigInt(decimals);
  const scaledFrac = decimals > 0 ? BigInt(frac.padEnd(decimals, "0")) : BigInt(0);
  const stroops = BigInt(whole || "0") * base + scaledFrac;
  if (stroops <= BigInt(0)) {
    return { ok: false, reason: "The amount must be more than zero." };
  }
  return { ok: true, stroops };
}

/** Parses a human-typed token amount into base units (`10 ** decimals`).
 * Returns null when the input is not a positive amount with at most `decimals`
 * decimal places. */
export function parseUnits(text: string, decimals = DEFAULT_DECIMALS): bigint | null {
  const result = parseXlmAmount(text, decimals);
  return result.ok ? result.stroops : null;
}

/** Parses an XLM amount a person typed into stroops (7 decimals). Null when it
 * is not a positive amount with at most 7 decimal places. */
export function xlmToStroops(input: string): bigint | null {
  return parseUnits(input, DEFAULT_DECIMALS);
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
  MissingTrustline:
    "Your account needs a trustline to the bond asset and a balance in it before EscrowGate can transfer it.",
  NoTrustline:
    "Your account needs a trustline to the bond asset and a balance in it before EscrowGate can transfer it.",
  NoTrust:
    "Your account needs a trustline to the bond asset and a balance in it before EscrowGate can transfer it.",
};

/** Plain-language explanation for contract error names a dashboard user can trigger. */
export function describeContractError(name: string): string | null {
  if (Object.hasOwn(CONTRACT_ERROR_DESCRIPTIONS, name)) {
    return CONTRACT_ERROR_DESCRIPTIONS[name];
  }
  return null;
}

/** Note shown on forms when the deployment bonds in a non-native asset, and
 * used when a transaction fails because the account lacks a trustline to it. */
export function trustlineNote(symbol: string): string {
  return `Your account needs a trustline to ${symbol} and a ${symbol} balance before EscrowGate can transfer ${symbol}.`;
}

const TRUSTLINE_ERROR_RE = /trustline|no[_ -]?trust|missing[_ -]?trust/i;

/** Maps a relay or simulation failure caused by a missing trustline to a
 * plain explanation naming the deployment's bond asset. */
export function mapTrustlineError(err: unknown, symbol = "the bond asset"): string {
  const message = err instanceof Error ? err.message : String(err);
  if (TRUSTLINE_ERROR_RE.test(message)) {
    return trustlineNote(symbol);
  }
  return message;
}

