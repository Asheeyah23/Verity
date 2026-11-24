import type { ChallengeResolution } from "@verity/db";
import { fromChainResolution, fromChainResolutionMethod } from "../chain/mappers.js";

/** What a challenge-closing event writes to the challenge row. */
export interface ChallengeClosure {
  resolution: ChallengeResolution | null;
  resolution_method: "reexecution_consensus" | "zk_proof" | null;
}

/** A challenge row only ever records a resolution method the contract
 * accepted; anything else (None, or a method this deployment cannot use)
 * stays null. */
export function challengeResolutionMethod(v: unknown): "reexecution_consensus" | "zk_proof" | null {
  const method = fromChainResolutionMethod(v);
  return method === "reexecution_consensus" || method === "zk_proof" ? method : null;
}

/**
 * The two contract events that close a challenge.
 *
 * `challenge_resolved` carries the outcome a bonded consensus reached and how.
 * `challenge_expired` carries nothing beyond the submission id: the challenge
 * lapsed with no resolution and both bonds went back, so the row is closed as
 * `expired`, with no method. Its payload is not read, so nothing in it can
 * turn an expiry into a decided challenge.
 */
export function challengeClosure(
  kind: "challenge_resolved" | "challenge_expired",
  value: unknown,
): ChallengeClosure {
  if (kind === "challenge_expired") return { resolution: "expired", resolution_method: null };
  const v = (typeof value === "object" && value !== null ? value : {}) as {
    resolution?: unknown;
    method?: unknown;
  };
  return {
    resolution: fromChainResolution(v.resolution),
    resolution_method: challengeResolutionMethod(v.method),
  };
}
