import type { SubmissionStatus, SubmissionResolutionMethod } from "./types";

export type VerdictTone = "pending" | "verified" | "disputed" | "slashed" | "expired" | "neutral";

export interface VerdictDescription {
  label: string;
  tone: VerdictTone;
  mechanism: string;
  short: string;
}

/**
 * PRD §10 hard requirement: every verdict display must state how it was
 * reached, and never imply a guarantee this deployment cannot back. Three
 * things are kept apart here, all driven by what the contract recorded:
 *
 *  - a bonded re-execution consensus (economic, not cryptographic);
 *  - a window that simply elapsed — the work was never replayed to quorum,
 *    so it is not shown in the same green as work that was;
 *  - a ZK proof (Phase 2; the contract accepts none today, so this cannot
 *    occur, but the label follows the real field rather than assuming).
 */
export function describeVerdict(
  status: SubmissionStatus,
  method: SubmissionResolutionMethod | null | undefined,
  hasChallenge: boolean
): VerdictDescription {
  switch (status) {
    case "pending":
      return {
        label: "Pending",
        tone: "pending",
        mechanism: "Awaiting replay consensus or the end of its challenge window",
        short: "Awaiting consensus",
      };
    case "disputed":
      return {
        label: "Disputed",
        tone: "disputed",
        mechanism: "Challenge open, awaiting replay consensus",
        short: "Challenge open",
      };
    case "expired_unverified":
      return {
        label: "Expired, unverified",
        tone: "expired",
        mechanism: hasChallenge
          ? "Challenge expired without a replay consensus. Both bonds returned."
          : "Window closed with a mismatch reported but no quorum. Bond returned.",
        short: "No consensus reached",
      };
    case "verified":
      if (method === "window_elapsed") {
        return {
          label: "Verified by default",
          tone: "neutral",
          mechanism: "Unchallenged when its window closed. Not replayed to quorum.",
          short: "Window elapsed, not replayed",
        };
      }
      break;
    case "slashed":
      break;
  }
  const label = status === "verified" ? "Verified" : "Slashed";
  const tone: VerdictTone = status === "verified" ? "verified" : "slashed";
  if (method === "zk_proof") return { label, tone, mechanism: "Cryptographic ZK proof", short: "ZK proof" };
  if (method === "reexecution_consensus") {
    return {
      label,
      tone,
      mechanism: "Bonded re-execution consensus, not a cryptographic proof",
      short: "Re-execution consensus",
    };
  }
  // Finalized on-chain, but the method has not been mirrored from the
  // contract yet. Say nothing rather than guess.
  return { label, tone, mechanism: "Finalized on-chain", short: "Finalized on-chain" };
}
