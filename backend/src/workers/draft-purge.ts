import { BUILT_TX_VALIDITY_MS, type ChainTxStatus } from "../modules/submissions/supersede.js";

/** RPC event retention (~7 days, matching indexer.ts and scheduler.ts).
 * RPC transaction retention is much shorter (~24 h or less), so a NOT_FOUND
 * from getTransaction within this window does not prove the transaction never
 * landed: the indexer may still reach its submission_created event. Only once
 * both the transaction's validity window and this retention window have
 * elapsed do we give up on an unresolved relayed draft. */
export const RELAYED_DRAFT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** What purgeDraftsOnce() should do with a draft row (chain_submission_id is null).
 *
 * - `keep`: leave the row untouched (not yet expired, still in flight, or
 *   NOT_FOUND while still within the retention window).
 * - `adopt`: the relayed transaction succeeded on-chain; attach its submission
 *   id and assign replay jobs instead of deleting it.
 * - `delete`: safe to purge silently (an expired unsigned draft, or an expired
 *   relayed draft whose transaction definitively FAILED on-chain).
 * - `give_up`: an expired relayed draft is still NOT_FOUND past both its
 *   transaction time bound and the retention window; log loudly and delete. */
export type DraftPurgeDecision = "keep" | "adopt" | "delete" | "give_up";

export interface DraftPurgeInput {
  updatedAt: Date;
  relayStartedAt: Date | null;
  chainStatus?: ChainTxStatus;
  draftTtlMs: number;
  now?: number;
  txValidityMs?: number;
  retentionMs?: number;
}

export function decideDraftPurge(input: DraftPurgeInput): DraftPurgeDecision {
  const now = input.now ?? Date.now();
  const draftAgeMs = now - input.updatedAt.getTime();

  if (!input.relayStartedAt) {
    return draftAgeMs >= input.draftTtlMs ? "delete" : "keep";
  }

  if (input.chainStatus === "SUCCESS") return "adopt";
  if (draftAgeMs < input.draftTtlMs) return "keep";
  if (input.chainStatus === "FAILED") return "delete";

  const relayAgeMs = now - input.relayStartedAt.getTime();
  const txValidityMs = input.txValidityMs ?? BUILT_TX_VALIDITY_MS;
  const retentionMs = input.retentionMs ?? RELAYED_DRAFT_RETENTION_MS;
  return relayAgeMs >= txValidityMs && relayAgeMs >= retentionMs ? "give_up" : "keep";
}
