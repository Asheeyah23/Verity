import { scValToNative } from "@stellar/stellar-sdk";
import { sql } from "kysely";
import type { ChallengeRecord, SubmissionRecord } from "escrow-gate";
import { db } from "../db.js";
import { env } from "../config/env.js";
import { server } from "../chain/rpc.js";
import {
  consensusOutcome,
  finalizeOnChain,
  minChallengerBond,
  readChallenge,
  readSubmission,
  releaseAttestationLockOnChain,
  resolveChallengeOnChain,
} from "../chain/actions.js";
import type { ChallengeResolution } from "@verity/db";
import { challengeResolutionMethod, fromChainResolution, fromChainResolutionMethod, fromChainVerdict } from "../chain/mappers.js";
import { recordTerminalVerdict } from "../modules/submissions/verdict.js";
import { exportAttestation } from "../modules/attestations/export.js";
import { escalateToFullReplay, topUpAssignments } from "../modules/reexecutors/assignment.js";
import { dispatchWebhook } from "../modules/webhooks/dispatcher.js";
import type { ChainTxStatus } from "../modules/submissions/supersede.js";
import { adoptSubmission, maybeEarlyFinalize } from "./indexer.js";
import { decideDraftPurge } from "./draft-purge.js";

export interface ReadyToSettleSubmission {
  status: string;
  resolution_method: string | null;
  has_attestation: boolean;
}

/** A submission may only be marked settled once it has a terminal status,
 * a known resolution method, and a persisted attestation export. */
export function isReadyToSettle(sub: ReadyToSettleSubmission): boolean {
  if (!["verified", "slashed", "expired_unverified"].includes(sub.status)) {
    return false;
  }
  if (!sub.resolution_method) {
    return false;
  }
  if (!sub.has_attestation) {
    return false;
  }
  return true;
}

/** How long settlement waits for the indexer to catch up on a submission's
 * votes before settling with the ones it has. */
const SETTLE_GRACE_S = 600;

/** A finalize() that came back Pending (or failed) is retried after this
 * long, rather than on every tick or never again. */
const FINALIZE_RETRY_S = 60;

/** Sweeps submissions whose challenge window has elapsed with no open
 * challenge, and calls the real, keeper-signed finalize() on each.
 * finalize_attempted_at throttles retries across sweep ticks; finalize()
 * itself is idempotent on-chain regardless (invariant 3). */
export async function sweepOnce(): Promise<number> {
  const due = await db
    .selectFrom("submission")
    .selectAll()
    .where("status", "=", "pending")
    .where("chain_submission_id", "is not", null)
    .where(sql<boolean>`submitted_at + (challenge_window_s || ' seconds')::interval <= now()`)
    .where((eb) =>
      eb.or([
        eb("finalize_attempted_at", "is", null),
        eb("finalize_attempted_at", "<", sql<Date>`now() - (${FINALIZE_RETRY_S} || ' seconds')::interval`),
      ])
    )
    .execute();

  for (const sub of due) {
    await db
      .updateTable("submission")
      .set({ finalize_attempted_at: new Date() })
      .where("id", "=", sub.id)
      .execute();
    try {
      const { status, txHash } = await finalizeOnChain(sub.chain_submission_id!);
      await recordTerminalVerdict(sub.id, status, txHash);
    } catch (err) {
      console.error(`[scheduler] finalize failed for submission ${sub.id}:`, err);
    }
  }
  return due.length;
}

/** Invariant 1's fast path: a pending submission that already has votes may
 * have reached a bonded supermajority. The indexer tries this the moment a
 * vote arrives; this pass is the retry for when that attempt failed or lost
 * a race, so a submission never waits out its whole window needlessly. */
export async function earlyFinalizeOnce(): Promise<number> {
  const candidates = await db
    .selectFrom("submission")
    .select(["submission.id", "submission.chain_submission_id"])
    .where("submission.status", "=", "pending")
    .where("submission.chain_submission_id", "is not", null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("replay")
          .select("replay.id")
          .whereRef("replay.submission_id", "=", "submission.id")
          .where("replay.status", "=", "confirmed_onchain")
      )
    )
    .execute();
  for (const row of candidates) {
    try {
      await maybeEarlyFinalize(row.id, row.chain_submission_id!);
    } catch (err) {
      console.error(`[scheduler] early finalize failed for submission ${row.id}:`, err);
    }
  }
  return candidates.length;
}

/** resolve_challenge is permissionless and only succeeds once the bonded
 * re-execution tally has reached consensus, so the keeper just watches open
 * challenges and submits it the moment the on-chain tally allows. The
 * contract then finalizes and settles in the same transaction. */
export async function resolveChallengesOnce(): Promise<number> {
  const open = await db
    .selectFrom("challenge")
    .innerJoin("submission", "submission.id", "challenge.submission_id")
    .select(["submission.id", "submission.chain_submission_id"])
    .where("challenge.resolved_at", "is", null)
    .where("submission.status", "=", "disputed")
    .where("submission.chain_submission_id", "is not", null)
    .execute();

  let resolved = 0;
  for (const row of open) {
    try {
      const record = await readSubmission(row.chain_submission_id!);
      if (!record || record.finalized || !consensusOutcome(record)) continue;
      const { status, txHash } = await resolveChallengeOnChain(row.chain_submission_id!);
      await recordTerminalVerdict(row.id, status, txHash);
      resolved++;
    } catch (err) {
      console.error(`[scheduler] resolve_challenge failed for submission ${row.id}:`, err);
    }
  }
  return resolved;
}

/** A challenge re-executors never reached consensus on must not freeze the
 * agent's and challenger's bonds forever: one full challenge window after it
 * was opened, finalize() expires it (ExpiredUnverified) and returns both
 * bonds. Until then — or while a consensus exists — finalize() is a no-op. */
export async function expireChallengesOnce(): Promise<number> {
  const stale = await db
    .selectFrom("challenge")
    .innerJoin("submission", "submission.id", "challenge.submission_id")
    .select(["submission.id", "submission.chain_submission_id"])
    .where("challenge.resolved_at", "is", null)
    .where("submission.status", "=", "disputed")
    .where("submission.chain_submission_id", "is not", null)
    .where(sql<boolean>`challenge.opened_at + (submission.challenge_window_s || ' seconds')::interval <= now()`)
    .where((eb) =>
      eb.or([
        eb("submission.finalize_attempted_at", "is", null),
        eb("submission.finalize_attempted_at", "<", sql<Date>`now() - (${FINALIZE_RETRY_S} || ' seconds')::interval`),
      ])
    )
    .execute();

  for (const row of stale) {
    await db.updateTable("submission").set({ finalize_attempted_at: new Date() }).where("id", "=", row.id).execute();
    try {
      const { status, txHash } = await finalizeOnChain(row.chain_submission_id!);
      await recordTerminalVerdict(row.id, status, txHash);
    } catch (err) {
      console.error(`[scheduler] challenge expiry failed for submission ${row.id}:`, err);
    }
  }
  return stale.length;
}

/** After a terminal verdict: release every attester's stake lock so honest
 * re-executors are free to withdraw. The contract slashes a vote the
 * consensus proved wrong in that same call — who, and how much, is decided
 * on-chain from the recorded votes (invariant 2), so the keeper neither
 * chooses nor computes anything here; the resulting Slashed event is what
 * the indexer records. A verdict that only defaulted when the window elapsed
 * slashes nobody. settled_at is only stamped once every step has succeeded,
 * so a partial failure is simply retried on the next tick. */
export async function settleOnce(): Promise<number> {
  const unsettled = await db
    .selectFrom("submission")
    .selectAll()
    .where("status", "in", ["verified", "slashed", "expired_unverified"])
    .where("chain_submission_id", "is not", null)
    .where("settled_at", "is", null)
    .execute();

  let settled = 0;
  for (const sub of unsettled) {
    try {
      const votes = await db
        .selectFrom("replay")
        .innerJoin("reexecutor", "reexecutor.id", "replay.reexecutor_id")
        .select(["replay.id", "replay.lock_released_at", "reexecutor.stellar_account"])
        .where("replay.submission_id", "=", sub.id)
        .where("replay.status", "=", "confirmed_onchain")
        .execute();

      // Wait until the indexer has recorded every on-chain vote, or a late
      // one would be left with its stake lock never released.
      // Vote events can be lost for good (RPC retention, a skipped event), so
      // after a grace period settle the votes we do know about rather than
      // leaving every one of them locked.
      const record = await readSubmission(sub.chain_submission_id!);
      if (!record) continue;

      if (!sub.resolution_method && record.resolution_method) {
        const resolvedMethod = fromChainResolutionMethod(record.resolution_method);
        if (resolvedMethod) {
          await db
            .updateTable("submission")
            .set({ resolution_method: resolvedMethod, updated_at: new Date() })
            .where("id", "=", sub.id)
            .where("resolution_method", "is", null)
            .execute();
          sub.resolution_method = resolvedMethod;
        }
      }

      const onChainVotes = record.match_votes + record.mismatch_votes;
      if (votes.length < onChainVotes) {
        const waitedS = (Date.now() - new Date(sub.updated_at).getTime()) / 1000;
        if (waitedS < SETTLE_GRACE_S) continue;
        console.warn(
          `[scheduler] settling submission ${sub.id} with ${votes.length}/${onChainVotes} votes indexed; the rest can be released by anyone via release_attestation_lock()`
        );
      }

      for (const vote of votes) {
        if (vote.lock_released_at) continue;
        await releaseAttestationLockOnChain(sub.chain_submission_id!, vote.stellar_account);
        await db
          .updateTable("replay")
          .set({ lock_released_at: new Date() })
          .where("id", "=", vote.id)
          .execute();
      }

      // Assignments nobody completed can no longer be attested (the contract
      // rejects votes on a finalized submission). One that had real time to
      // answer and did not is kept, marked missed: that is part of the
      // re-executor's record. One that was simply overtaken — a spare
      // assignee whose turn came seconds before a fast consensus finalized
      // the submission — did nothing wrong and is dropped without a mark.
      const finalizedAt = new Date(sub.updated_at);
      const hadTimeBefore = new Date(finalizedAt.getTime() - env.REPLAY_REASSIGN_AFTER_S * 1000);
      await db
        .updateTable("replay")
        .set({ status: "missed" })
        .where("submission_id", "=", sub.id)
        .where("status", "=", "assigned")
        .where("assigned_at", "<=", hadTimeBefore)
        .execute();
      await db
        .deleteFrom("replay")
        .where("submission_id", "=", sub.id)
        .where("status", "=", "assigned")
        .execute();

      // Signed only now, with every indexed vote in hand, so the attestation
      // lists the complete evidence.
      const attestationResult = await exportAttestation(sub.id);
      if (attestationResult === "not_ready") {
        continue;
      }

      const attestation = await db
        .selectFrom("attestation_export")
        .select(["id"])
        .where("submission_id", "=", sub.id)
        .executeTakeFirst();

      if (
        !isReadyToSettle({
          status: sub.status,
          resolution_method: sub.resolution_method,
          has_attestation: Boolean(attestation),
        })
      ) {
        continue;
      }

      await db
        .updateTable("submission")
        .set({ settled_at: new Date(), updated_at: new Date() })
        .where("id", "=", sub.id)
        .execute();
      settled++;
    } catch (err) {
      console.error(`[scheduler] settlement failed for submission ${sub.id}:`, err);
    }
  }
  return settled;
}

/** How often to repeat the warning for an unresolved relayed draft that is
 * still being kept while waiting for the indexer or retention window. */
const KEPT_DRAFT_LOG_INTERVAL_MS = 60 * 60 * 1000;
const keptRelayedDraftLogAt = new Map<string, number>();

/** POST /v1/submissions stores a draft row before the agent signs.
 *
 * - Unsigned drafts (`relay_started_at is null`) were never broadcast and are
 *   deleted once `updated_at` is older than `DRAFT_TTL_S`. Age is counted from
 *   `updated_at`, not `created_at`: a retry of a draft rebuilds the transaction
 *   and bumps only `updated_at`, so the clock restarts with each new tx.
 * - Relayed drafts (`relay_started_at is not null`) were broadcast and may have
 *   landed on-chain even if the relay timed out or the backend went down before
 *   the indexer processed `submission_created`. Each expired relayed draft is
 *   checked on-chain first: adopted if SUCCESS, purged if FAILED, and kept
 *   across the retention window if NOT_FOUND so the indexer can still catch up. */
export async function purgeDraftsOnce(): Promise<number> {
  const unsigned = await db
    .deleteFrom("submission")
    .where("chain_submission_id", "is", null)
    .where("relay_started_at", "is", null)
    .where("updated_at", "<", sql<Date>`now() - (${env.DRAFT_TTL_S} || ' seconds')::interval`)
    .executeTakeFirst();
  let deleted = Number(unsigned.numDeletedRows ?? 0);

  const relayed = await db
    .selectFrom("submission")
    .select([
      "id",
      "task_type",
      "escrow_value",
      "min_challenger_bond",
      "challenge_window_s",
      "chain_tx_hash",
      "relay_started_at",
      "updated_at",
    ])
    .where("chain_submission_id", "is", null)
    .where("relay_started_at", "is not", null)
    .where("updated_at", "<", sql<Date>`now() - (${env.DRAFT_TTL_S} || ' seconds')::interval`)
    .execute();

  const draftTtlMs = env.DRAFT_TTL_S * 1000;
  const keptIds = new Set<string>();

  for (const draft of relayed) {
    try {
      const now = Date.now();
      const relayStartedAt = new Date(draft.relay_started_at!);
      const updatedAt = new Date(draft.updated_at);

      const tx = draft.chain_tx_hash ? await server.getTransaction(draft.chain_tx_hash) : null;
      const chainStatus: ChainTxStatus = (tx?.status as ChainTxStatus | undefined) ?? "NOT_FOUND";
      const decision = decideDraftPurge({
        updatedAt,
        relayStartedAt,
        chainStatus,
        draftTtlMs,
        now,
      });

      if (decision === "adopt") {
        const returnValue = tx && tx.status === "SUCCESS" && tx.returnValue ? scValToNative(tx.returnValue) : null;
        if (typeof returnValue !== "bigint") {
          console.error(
            `[scheduler] relayed draft ${draft.id} (tx ${draft.chain_tx_hash}) succeeded on-chain but returned no u64 submission id; keeping draft for indexer`
          );
          keptIds.add(draft.id);
          continue;
        }
        const chainSubmissionId = returnValue.toString();
        await adoptSubmission(draft, chainSubmissionId, draft.chain_tx_hash!);
        console.info(
          `[scheduler] adopted relayed draft ${draft.id} as chain submission #${chainSubmissionId} (tx ${draft.chain_tx_hash})`
        );
        continue;
      }

      if (decision === "keep") {
        keptIds.add(draft.id);
        const lastLogged = keptRelayedDraftLogAt.get(draft.id);
        if (lastLogged === undefined || now - lastLogged >= KEPT_DRAFT_LOG_INTERVAL_MS) {
          console.warn(
            `[scheduler] keeping expired relayed draft ${draft.id} (tx ${draft.chain_tx_hash ?? "none"}, relay_started_at=${relayStartedAt.toISOString()}): transaction is ${chainStatus} on RPC`
          );
          keptRelayedDraftLogAt.set(draft.id, now);
        }
        continue;
      }

      if (decision === "give_up") {
        const ageHours = ((now - relayStartedAt.getTime()) / (60 * 60 * 1000)).toFixed(1);
        console.error(
          `[scheduler] giving up on relayed draft ${draft.id} (tx ${draft.chain_tx_hash ?? "none"}, relay_started_at=${relayStartedAt.toISOString()}, age=${ageHours}h): transaction still NOT_FOUND past retention window; deleting draft`
        );
      }

      // Guard the delete against concurrent adoption by the indexer or a
      // rebuild of the draft with a new chain_tx_hash via POST /v1/submissions.
      let del = db
        .deleteFrom("submission")
        .where("id", "=", draft.id)
        .where("chain_submission_id", "is", null)
        .where("relay_started_at", "is not", null);
      del = draft.chain_tx_hash
        ? del.where("chain_tx_hash", "=", draft.chain_tx_hash)
        : del.where("chain_tx_hash", "is", null);
      const res = await del.executeTakeFirst();
      deleted += Number(res.numDeletedRows ?? 0);
    } catch (err) {
      keptIds.add(draft.id);
      console.error(`[scheduler] relayed draft check failed for submission ${draft.id}:`, err);
    }
  }

  for (const id of keptRelayedDraftLogAt.keys()) {
    if (!keptIds.has(id)) keptRelayedDraftLogAt.delete(id);
  }

  return deleted;
}

export function shouldCheckOnChainChallenge(params: {
  status: string;
  submittedAtMs: number;
  challengeWindowMs: number;
  hasConfirmedVotes: boolean;
  hasChallengeRow: boolean;
  nowMs?: number;
}): boolean {
  const { status, submittedAtMs, challengeWindowMs, hasConfirmedVotes, hasChallengeRow, nowMs = Date.now() } = params;
  if (status === "pending") {
    const isPastWindow = nowMs >= submittedAtMs + challengeWindowMs;
    return isPastWindow || hasConfirmedVotes;
  }
  if (status === "disputed") {
    return !hasChallengeRow;
  }
  return false;
}

export function submissionRepairPatch(
  row: {
    submitted_at: Date | null;
    challenge_window_s: number;
    min_challenger_bond: string | null;
  },
  record: SubmissionRecord
): {
  submitted_at?: Date;
  challenge_window_s?: number;
  min_challenger_bond?: string;
} | null {
  const expectedSubmittedAt = new Date(Number(record.submitted_at) * 1000);
  const expectedWindowS = Number(record.challenge_window_s);
  const expectedMinBond = minChallengerBond(record).toString();

  const patch: {
    submitted_at?: Date;
    challenge_window_s?: number;
    min_challenger_bond?: string;
  } = {};

  if (!row.submitted_at || row.submitted_at.getTime() !== expectedSubmittedAt.getTime()) {
    patch.submitted_at = expectedSubmittedAt;
  }
  if (row.challenge_window_s !== expectedWindowS) {
    patch.challenge_window_s = expectedWindowS;
  }
  if (row.min_challenger_bond !== expectedMinBond) {
    patch.min_challenger_bond = expectedMinBond;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export interface ChallengeDecisionInput {
  submissionId: string;
  status: string;
  existingChallenge: { id: string; resolved_at: Date | null } | null;
  chainChallenge: ChallengeRecord | null;
  now?: Date;
}

export type ChallengeDecision =
  | {
      action: "insert";
      values: {
        submission_id: string;
        challenger_account: string;
        challenger_bond: string;
        opened_at: Date;
        chain_tx_hash: null;
        resolution?: ChallengeResolution;
        resolution_method?: "reexecution_consensus" | "zk_proof";
        resolved_at?: Date;
      };
      markDisputed: boolean;
      dispatchWebhook: boolean;
    }
  | {
      action: "update";
      values: {
        resolution: ChallengeResolution;
        resolution_method?: "reexecution_consensus" | "zk_proof";
        resolved_at: Date;
      };
    }
  | {
      action: "none";
    };

export function reconcileChallengeDecision(input: ChallengeDecisionInput): ChallengeDecision {
  const { submissionId, status, existingChallenge, chainChallenge, now = new Date() } = input;
  if (!chainChallenge) {
    return { action: "none" };
  }

  const resolution = fromChainResolution(chainChallenge.resolution);
  const method = challengeResolutionMethod(chainChallenge.resolution_method);

  if (!existingChallenge) {
    const values: {
      submission_id: string;
      challenger_account: string;
      challenger_bond: string;
      opened_at: Date;
      chain_tx_hash: null;
      resolution?: ChallengeResolution;
      resolution_method?: "reexecution_consensus" | "zk_proof";
      resolved_at?: Date;
    } = {
      submission_id: submissionId,
      challenger_account: chainChallenge.challenger,
      challenger_bond: chainChallenge.bond.toString(),
      opened_at: new Date(Number(chainChallenge.opened_at) * 1000),
      chain_tx_hash: null,
    };
    if (resolution !== null) {
      values.resolution = resolution;
      if (method) values.resolution_method = method;
      values.resolved_at = now;
    }
    return {
      action: "insert",
      values,
      markDisputed: status === "pending",
      dispatchWebhook: true,
    };
  }

  if (existingChallenge.resolved_at === null && resolution !== null) {
    return {
      action: "update",
      values: {
        resolution,
        resolution_method: method ?? undefined,
        resolved_at: now,
      },
    };
  }

  return { action: "none" };
}

/** The chain is the source of truth and events can be missed (RPC event
 * retention is ~7 days; anyone may call finalize()/resolve_challenge()
 * directly). Re-read every still-open submission and adopt any terminal
 * verdict the contract already holds. */
export async function reconcileOnce(): Promise<number> {
  const open = await db
    .selectFrom("submission")
    .select([
      "id",
      "chain_submission_id",
      "status",
      "submitted_at",
      "challenge_window_s",
      "min_challenger_bond",
      "marketplace_id",
    ])
    .where("status", "in", ["pending", "disputed"])
    .where("chain_submission_id", "is not", null)
    .execute();

  let changed = 0;
  for (const row of open) {
    try {
      const record = await readSubmission(row.chain_submission_id!);
      if (!record) continue;

      if (record.finalized) {
        const status = fromChainVerdict(record.verdict);
        if (status !== row.status) {
          await recordTerminalVerdict(row.id, status);
          changed++;
        }
        continue;
      }

      // Repair submitted_at / challenge_window_s / min_challenger_bond when they differ
      const repairPatch = submissionRepairPatch(row, record);
      if (repairPatch) {
        await db
          .updateTable("submission")
          .set({ ...repairPatch, updated_at: new Date() })
          .where("id", "=", row.id)
          .execute();
        if (repairPatch.submitted_at) row.submitted_at = repairPatch.submitted_at;
        if (repairPatch.challenge_window_s !== undefined) row.challenge_window_s = repairPatch.challenge_window_s;
        if (repairPatch.min_challenger_bond !== undefined) row.min_challenger_bond = repairPatch.min_challenger_bond;
      }

      let hasChallengeRow = false;
      let existingChallenge: { id: string; resolved_at: Date | null } | null = null;

      if (row.status === "disputed") {
        const challengeInDb = await db
          .selectFrom("challenge")
          .select(["id", "resolved_at"])
          .where("submission_id", "=", row.id)
          .executeTakeFirst();
        if (challengeInDb) {
          hasChallengeRow = true;
          existingChallenge = challengeInDb;
        }
      }

      let hasConfirmedVotes = false;
      if (row.status === "pending") {
        const vote = await db
          .selectFrom("replay")
          .select("id")
          .where("submission_id", "=", row.id)
          .where("status", "=", "confirmed_onchain")
          .executeTakeFirst();
        hasConfirmedVotes = !!vote;
      }

      const shouldCheck = shouldCheckOnChainChallenge({
        status: row.status,
        submittedAtMs: Number(record.submitted_at) * 1000,
        challengeWindowMs: Number(record.challenge_window_s) * 1000,
        hasConfirmedVotes,
        hasChallengeRow,
      });

      if (!shouldCheck) continue;

      const chainChallenge = await readChallenge(row.chain_submission_id!);
      if (!chainChallenge) continue;

      if (row.status !== "disputed") {
        const challengeInDb = await db
          .selectFrom("challenge")
          .select(["id", "resolved_at"])
          .where("submission_id", "=", row.id)
          .executeTakeFirst();
        if (challengeInDb) {
          existingChallenge = challengeInDb;
        }
      }

      const decision = reconcileChallengeDecision({
        submissionId: row.id,
        status: row.status,
        existingChallenge,
        chainChallenge,
      });

      if (decision.action === "insert") {
        const inserted = await db
          .insertInto("challenge")
          .values(decision.values)
          .onConflict((oc) => oc.doNothing())
          .returningAll()
          .executeTakeFirst();

        if (inserted) {
          if (decision.markDisputed) {
            await db
              .updateTable("submission")
              .set({ status: "disputed", updated_at: new Date() })
              .where("id", "=", row.id)
              .where("status", "=", "pending")
              .execute();
          }
          await escalateToFullReplay(row.id);
          if (decision.dispatchWebhook) {
            await dispatchWebhook(row.marketplace_id, "submission.disputed", {
              submission_id: row.id,
              status: "disputed",
              tx_hash: null,
            }).catch((err) => console.error("[scheduler] webhook dispatch failed:", err));
          }
          changed++;
        }
      } else if (decision.action === "update") {
        await db
          .updateTable("challenge")
          .set(decision.values)
          .where("submission_id", "=", row.id)
          .where("resolved_at", "is", null)
          .execute();
        changed++;
      }
    } catch (err) {
      console.error(`[scheduler] reconcile failed for submission ${row.id}:`, err);
    }
  }
  return changed;
}

export function startScheduler(intervalMs = 10000): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const step = async (name: string, fn: () => Promise<number>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[scheduler] ${name} failed:`, err);
    }
  };
  const tick = async () => {
    if (stopped) return;
    await step("reconcile", reconcileOnce);
    await step("top-up-assignments", topUpAssignments);
    await step("early-finalize", earlyFinalizeOnce);
    await step("sweep", sweepOnce);
    await step("resolve-challenges", resolveChallengesOnce);
    await step("expire-challenges", expireChallengesOnce);
    await step("settle", settleOnce);
    await step("purge-drafts", purgeDraftsOnce);
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
