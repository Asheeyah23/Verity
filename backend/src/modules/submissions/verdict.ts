import type { SubmissionStatus } from "@verity/db";
import { db } from "../../db.js";
import { readSubmission } from "../../chain/actions.js";
import { fromChainResolutionMethod } from "../../chain/mappers.js";
import { dispatchWebhook } from "../webhooks/dispatcher.js";

const TERMINAL = ["verified", "slashed", "expired_unverified"] as const satisfies readonly SubmissionStatus[];
type TerminalStatus = (typeof TERMINAL)[number];

export interface VerdictDeps {
  db?: typeof db;
  readSubmission?: typeof readSubmission;
  dispatchWebhook?: typeof dispatchWebhook;
}

/** Single writer for "this submission reached a terminal on-chain verdict".
 * Called from every place a verdict can first be observed (the Finalized
 * event, the keeper's own finalize/resolve calls, the chain reconcile pass)
 * and safe to call repeatedly: the webhook fires only on the call that
 * actually moves the row into its terminal status.
 *
 * How the verdict was reached is read back from the contract, never assumed —
 * a window that elapsed without consensus must not be recorded as consensus. */
export async function recordTerminalVerdict(
  submissionRowId: string,
  status: string,
  txHash?: string | null,
  closedAt?: Date,
  deps: VerdictDeps = {}
) {
  if (!TERMINAL.includes(status as TerminalStatus)) return;
  const terminal = status as TerminalStatus;
  const database = deps.db ?? db;
  const readOnChain = deps.readSubmission ?? readSubmission;
  const dispatch = deps.dispatchWebhook ?? dispatchWebhook;

  const transitioned = await database
    .updateTable("submission")
    .set({ status: terminal, updated_at: new Date() })
    .where("id", "=", submissionRowId)
    .where("status", "!=", terminal)
    .returningAll()
    .executeTakeFirst();

  const sub =
    transitioned ??
    (await database.selectFrom("submission").selectAll().where("id", "=", submissionRowId).executeTakeFirst());
  if (!sub) return;

  // Dispatched before anything below that can throw (the contract read in
  // particular): a retry after a failure finds the row already terminal, so
  // the webhook would never fire for this verdict again.
  if (transitioned) {
    await dispatch(sub.marketplace_id, `submission.${terminal}`, {
      submission_id: sub.id,
      status: terminal,
      tx_hash: txHash ?? null,
    }).catch((err) => console.error("[verdict] webhook dispatch failed:", err));
  }

  // Filled in whenever they are still missing, so a call that knows the
  // finalize transaction can complete a row first written by one that did not.
  if (!sub.resolution_method || (txHash && !sub.finalize_tx_hash)) {
    const record = sub.chain_submission_id ? await readOnChain(sub.chain_submission_id) : null;
    await database
      .updateTable("submission")
      .set({
        resolution_method: sub.resolution_method ?? (record ? fromChainResolutionMethod(record.resolution_method) : null),
        finalize_tx_hash: sub.finalize_tx_hash ?? txHash ?? null,
      })
      .where("id", "=", sub.id)
      .execute();
  }

  if (terminal === "expired_unverified") {
    // A challenge that lapsed without a resolution is closed out off-chain too.
    await database
      .updateTable("challenge")
      .set({ resolved_at: closedAt ?? new Date() })
      .where("submission_id", "=", sub.id)
      .where("resolved_at", "is", null)
      .execute();
  }
}
