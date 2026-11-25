import { createHash } from "node:crypto";
import type { TaskType as ChainTaskType } from "escrow-gate";
import type { ChallengeResolution, SubmissionResolutionMethod, TaskType } from "@verity/db";

export function toChainTaskType(t: TaskType): ChainTaskType {
  if (t === "deterministic") return { tag: "Deterministic", values: void 0 };
  if (t === "retrieval") return { tag: "Retrieval", values: void 0 };
  return { tag: "Unverifiable", values: void 0 };
}

/** A fieldless #[contracttype] enum variant decodes differently depending on
 * the path: the generated Client's typed `.result`/`.unwrap()` gives
 * `{tag: "Verified", values: void}`, but the SDK's generic `scValToNative`
 * (used when decoding raw event values in the indexer) gives `["Verified"]`
 * — a bare array wrapping the variant name, no `.tag` at all. Handling only
 * the `{tag}` shape here silently fell through to the "pending" default for
 * every event-derived verdict, which is exactly the bug that reverted a
 * submission from "verified" back to "pending" after the indexer observed
 * its own Finalized event. This accepts either shape. */
function enumTag(v: unknown): string | undefined {
  if (Array.isArray(v)) return v[0] as string;
  if (v && typeof v === "object" && "tag" in v) return (v as { tag: string }).tag;
  if (typeof v === "string") return v;
  return undefined;
}

export type ChainVerdictStatus = "pending" | "verified" | "disputed" | "slashed" | "expired_unverified";

/** Maps the contract's `Verdict` enum (either decoding shape, see `enumTag`)
 * to a submission status. `Pending` is matched explicitly; anything else —
 * `undefined`, `null`, an unknown tag, a malformed object — throws rather
 * than being reported as "pending", so a decode failure surfaces in the
 * caller's error handling instead of silently reverting a verdict. */
export function fromChainVerdict(v: unknown): ChainVerdictStatus {
  switch (enumTag(v)) {
    case "Pending":
      return "pending";
    case "Verified":
      return "verified";
    case "Disputed":
      return "disputed";
    case "Slashed":
      return "slashed";
    case "ExpiredUnverified":
      return "expired_unverified";
    default:
      throw new Error(`fromChainVerdict: unrecognised verdict ${describeValue(v)}`);
  }
}

/** `JSON.stringify` for error messages, without letting a BigInt or a cycle
 * throw a different error, and without losing `undefined`. */
function describeValue(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** `Expired` is what finalize() writes on a challenge that lapsed with no
 * resolution. Null for `None` (still open) and for anything unrecognised. */
export function fromChainResolution(v: unknown): ChallengeResolution | null {
  const tag = enumTag(v);
  if (tag === "Upheld") return "upheld";
  if (tag === "Rejected") return "rejected";
  if (tag === "Expired") return "expired";
  return null;
}

/** Null for `None` (not resolved yet) and for anything unrecognised: an
 * unknown method must never be reported as re-execution consensus. */
export function fromChainResolutionMethod(v: unknown): SubmissionResolutionMethod | null {
  switch (enumTag(v)) {
    case "ReexecutionConsensus":
      return "reexecution_consensus";
    case "WindowElapsed":
      return "window_elapsed";
    case "ZkProof":
      return "zk_proof";
    default:
      return null;
  }
}

/** A challenge row only ever records a resolution the contract accepted;
 * anything else (None, or a method this deployment cannot use) stays null. */
export function challengeResolutionMethod(v: unknown): "reexecution_consensus" | "zk_proof" | null {
  const method = fromChainResolutionMethod(v);
  return method === "reexecution_consensus" || method === "zk_proof" ? method : null;
}

/** Deterministic 32-byte content address, matching what the contract expects
 * for BytesN<32> fields (escrow_ref/input_hash/output_hash). */
export function sha256Bytes(input: string | Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}

export function hex(buf: Buffer): string {
  return buf.toString("hex");
}

/** Convert a hex string into the 32-byte Buffer a BytesN<32> field expects.
 * It is for those values only; it rejects anything that is not exactly 64 hex
 * characters because Node's Buffer.from(str, "hex") silently stops at the
 * first invalid pair and drops a trailing odd nibble, which would otherwise
 * yield a shorter or different buffer than the caller intended. */
export function bufFromHex(h: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error(`expected 64 hex characters, got ${h.length}`);
  }
  return Buffer.from(h, "hex");
}
