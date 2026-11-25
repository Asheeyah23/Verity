import { scValToNative } from "@stellar/stellar-sdk";
import { sql } from "kysely";
import type { TaskType } from "@verity/db";
import { db } from "../db.js";
import { server } from "../chain/rpc.js";
import { env } from "../config/env.js";
import { fromChainVerdict, fromChainResolution, fromChainResolutionMethod, challengeResolutionMethod } from "../chain/mappers.js";
import {
  assignReplayJobs,
  escalateAgentPendingSubmissions,
  escalateToFullReplay,
} from "../modules/reexecutors/assignment.js";
import { escrowGateAsKeeper } from "../chain/clients.js";
import { consensusOutcome, finalizeOnChain, minChallengerBond, readSubmission } from "../chain/actions.js";
import { dispatchWebhook } from "../modules/webhooks/dispatcher.js";
import { recordTerminalVerdict } from "../modules/submissions/verdict.js";
import { isTransientError } from "./transient.js";

const CONTRACT_ID = env.ESCROW_GATE_CONTRACT_ID;

const PAGE_SIZE = 100;

interface Cursor {
  /** RPC paging cursor from the previous getEvents response; null on the
   * very first poll (or after a retention reset), when startLedger is used. */
  pagingToken: string | null;
  ledger: number;
}

async function getCursor(): Promise<Cursor> {
  const row = await db
    .selectFrom("chain_cursor")
    .selectAll()
    .where("contract_id", "=", CONTRACT_ID)
    .executeTakeFirst();
  if (row) return { pagingToken: row.last_paging_token, ledger: Number(row.last_ledger) };
  const latest = await server.getLatestLedger();
  const start = Math.max(latest.sequence - 100, 1);
  await db
    .insertInto("chain_cursor")
    .values({ contract_id: CONTRACT_ID, last_ledger: start })
    .onConflict((oc) => oc.column("contract_id").doNothing())
    .execute();
  return { pagingToken: null, ledger: start };
}

async function setCursor(ledger: number, pagingToken: string | null) {
  await db
    .updateTable("chain_cursor")
    .set({ last_ledger: ledger, last_paging_token: pagingToken, updated_at: new Date() })
    .where("contract_id", "=", CONTRACT_ID)
    .execute();
}

/** An RPC paging cursor is "<toid>-<index>", where the TOID's high 32 bits
 * are the ledger sequence. */
function ledgerOfPagingToken(token: string): number {
  return Number(BigInt(token.split("-")[0]) >> 32n);
}

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** Parses the RPC's ISO-8601 `ledgerClosedAt` string into a Date, falling
 * back to wall-clock time with a warning if the field is missing or malformed. */
export function parseLedgerClosedAt(
  ledgerClosedAt: unknown,
  context?: { id?: string; ledger?: number },
  now: () => Date = () => new Date(),
  warn: (message: string) => void = console.warn
): Date {
  if (typeof ledgerClosedAt === "string") {
    const trimmed = ledgerClosedAt.trim();
    if (ISO_TIMESTAMP_RE.test(trimmed)) {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  const where = context?.id ? `event ${context.id} (ledger ${context.ledger ?? "?"})` : "event";
  warn(
    `[indexer] invalid ledgerClosedAt (${String(ledgerClosedAt)}) on ${where}, falling back to current time`
  );
  return now();
}

export function buildReplayAttestedPatch(params: {
  outputHash: Buffer;
  matched: boolean;
  txHash: string;
  closedAt: Date;
}) {
  return {
    status: "confirmed_onchain" as const,
    replay_output_hash: params.outputHash.toString("hex"),
    match: params.matched,
    tx_hash: params.txHash,
    executed_at: params.closedAt,
  };
}

export function buildSpotCheckEvidence(params: {
  replayOutputHash: string;
  txHash: string;
  ledger: number;
  closedAt: Date;
}) {
  return {
    replay_output_hash: params.replayOutputHash,
    tx_hash: params.txHash,
    ledger: params.ledger,
    ledger_closed_at: params.closedAt.toISOString(),
  };
}

export function buildChallengeOpenedRow(params: {
  submissionId: string;
  challenger: string;
  bond: bigint;
  txHash: string;
  closedAt: Date;
}) {
  return {
    submission_id: params.submissionId,
    challenger_account: params.challenger,
    challenger_bond: params.bond.toString(),
    chain_tx_hash: params.txHash,
    opened_at: params.closedAt,
  };
}

export function buildChallengeResolvedPatch(params: {
  resolution: unknown;
  method: unknown;
  closedAt: Date;
}) {
  return {
    resolution: fromChainResolution(params.resolution),
    resolution_method: challengeResolutionMethod(params.method),
    resolved_at: params.closedAt,
  };
}

/** What `challenge_expired` writes. finalize() publishes it when a challenge
 * lapsed with no resolution, so there is no method, and the event carries
 * nothing to read but the submission it is about. */
export function buildChallengeExpiredPatch(params: { closedAt: Date }) {
  return {
    resolution: "expired" as const,
    resolution_method: null,
    resolved_at: params.closedAt,
  };
}

/** Idempotent by construction: every handler upserts on a unique key derived
 * from on-chain identity (chain_submission_id, (submission,reexecutor) pair,
 * etc.), so replaying the same event twice (e.g. after a restart) is safe. */
async function handleEvent(
  topic: unknown[],
  value: unknown,
  ledger: number,
  txHash: string,
  closedAt: Date
) {
  const kind = topic[0] as string;

  switch (kind) {
    case "submission_created": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { agent: string; escrow_ref: Buffer; escrow_value: bigint; bond: bigint };
      let row = await db
        .selectFrom("submission")
        .selectAll()
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      if (!row) {
        // POST /v1/submissions records the hash of the transaction it built
        // (a tx hash does not depend on its signatures), so the draft row
        // this event belongs to is identified exactly. A submit() made
        // directly on-chain with no draft has no off-chain artifacts to
        // replay and is intentionally not tracked here.
        row = await db
          .selectFrom("submission")
          .selectAll()
          .where("chain_tx_hash", "=", txHash)
          .where("chain_submission_id", "is", null)
          .executeTakeFirst();
      }
      if (row) {
        await adoptSubmission(row, chainSubmissionId, txHash, v.escrow_value);
      }
      break;
    }

    case "reexecutor_registered": {
      const account = topic[1] as string;
      const v = value as { active: boolean; stake_amount: bigint };
      const existing = await db
        .selectFrom("reexecutor")
        .selectAll()
        .where("stellar_account", "=", account)
        .executeTakeFirst();
      if (existing) {
        await db
          .updateTable("reexecutor")
          // last_seen_at is deliberately untouched: staking proves nothing
          // about whether a worker is running.
          .set({ active: v.active, stake_amount: v.stake_amount.toString() })
          .where("id", "=", existing.id)
          .execute();
      } else {
        await db
          .insertInto("reexecutor")
          .values({
            stellar_account: account,
            stake_amount: v.stake_amount.toString(),
            stake_asset: "native",
            active: v.active,
          })
          .execute();
      }
      break;
    }

    case "reexecutor_stake_withdrawn": {
      const account = topic[1] as string;
      const v = value as { new_stake: bigint; active: boolean };
      await db
        .updateTable("reexecutor")
        .set({ stake_amount: v.new_stake.toString(), active: v.active })
        .where("stellar_account", "=", account)
        .execute();
      break;
    }

    case "reexecutor_approval_changed": {
      const account = topic[1] as string;
      const v = value as { approved: boolean };
      await db
        .updateTable("reexecutor")
        .set({ approved: v.approved })
        .where("stellar_account", "=", account)
        .execute();
      break;
    }

    case "replay_attested": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { reexecutor: string; output_hash: Buffer; matched: boolean };
      const sub = await db
        .selectFrom("submission")
        .selectAll()
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      let rex = await db
        .selectFrom("reexecutor")
        .selectAll()
        .where("stellar_account", "=", v.reexecutor)
        .executeTakeFirst();
      if (sub && !rex) {
        // A vote can arrive from an account staked before this backend's
        // event-retention horizon (or registered directly on-chain), so there
        // is no mirror row yet. The vote is on-chain and counts toward
        // consensus; mirror the account from the contract and record it,
        // or settlement never releases that account's stake lock. An RPC
        // failure here propagates so the event is retried, not consumed.
        const info = (await escrowGateAsKeeper.reexecutor_info({ reexecutor: v.reexecutor })).result;
        if (!info) {
          console.warn(
            `[indexer] replay_attested by ${v.reexecutor} (tx ${txHash}) ignored: the contract knows no such re-executor`
          );
          break;
        }
        await db
          .insertInto("reexecutor")
          .values({
            stellar_account: v.reexecutor,
            stake_amount: info.stake_amount.toString(),
            stake_asset: "native",
            active: info.active,
            approved: info.approved,
          })
          // The /v1/reexecutors/sync route mirrors concurrently; whoever
          // loses the race reads the winner's row below.
          .onConflict((oc) => oc.column("stellar_account").doNothing())
          .execute();
        rex = await db
          .selectFrom("reexecutor")
          .selectAll()
          .where("stellar_account", "=", v.reexecutor)
          .executeTakeFirst();
      }
      if (sub && rex) {
        const existing = await db
          .selectFrom("replay")
          .selectAll()
          .where("submission_id", "=", sub.id)
          .where("reexecutor_id", "=", rex.id)
          .executeTakeFirst();
        const patch = buildReplayAttestedPatch({
          outputHash: v.output_hash,
          matched: v.matched,
          txHash,
          closedAt,
        });
        if (existing) {
          await db.updateTable("replay").set(patch).where("id", "=", existing.id).execute();
        } else {
          await db
            .insertInto("replay")
            .values({ submission_id: sub.id, reexecutor_id: rex.id, ...patch })
            .execute();
        }
        // If this re-executor was the sampled spot-checker, their on-chain
        // vote IS the spot-check result — recorded from the chain event, not
        // from a self-reported API call.
        const spotCheck = await db
          .updateTable("spot_check")
          .set({
            result: v.matched ? "match" : "mismatch",
            evidence: JSON.stringify(
              buildSpotCheckEvidence({
                replayOutputHash: patch.replay_output_hash,
                txHash,
                ledger,
                closedAt,
              })
            ),
          })
          .where("submission_id", "=", sub.id)
          .where("reexecutor_id", "=", rex.id)
          .where("result", "is", null)
          .returningAll()
          .executeTakeFirst();
        if (spotCheck && !v.matched) {
          await escalateToFullReplay(sub.id);
          await escalateAgentPendingSubmissions(sub.agent_id, sub.id);
        }
        // Opportunistic: the vote above is already recorded, and the
        // scheduler retries early finalization on its own, so a failure
        // here must never cost us the event.
        await maybeEarlyFinalize(sub.id, chainSubmissionId).catch((err) =>
          console.error(`[indexer] early finalize of submission #${chainSubmissionId} failed, scheduler will retry:`, err)
        );
      }
      break;
    }

    case "challenge_opened": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { challenger: string; bond: bigint };
      const sub = await db
        .selectFrom("submission")
        .selectAll()
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      if (sub) {
        await db
          .insertInto("challenge")
          .values(
            buildChallengeOpenedRow({
              submissionId: sub.id,
              challenger: v.challenger,
              bond: v.bond,
              txHash,
              closedAt,
            })
          )
          .onConflict((oc) => oc.doNothing())
          .returningAll()
          .executeTakeFirst()
          .then(async (inserted) => {
            if (!inserted) return;
            await dispatchWebhook(sub.marketplace_id, "submission.disputed", {
              submission_id: sub.id,
              status: "disputed",
              tx_hash: txHash,
            }).catch((err) => console.error("[indexer] webhook dispatch failed:", err));
          });
        await db
          .updateTable("submission")
          .set({ status: "disputed", updated_at: new Date() })
          .where("id", "=", sub.id)
          .where("status", "=", "pending")
          .execute();
        // A challenge is only ever resolved by bonded re-execution consensus,
        // so make sure a full quorum is actually working on it.
        await escalateToFullReplay(sub.id);
      }
      break;
    }

    case "challenge_resolved": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { resolution: unknown; method: unknown };
      const sub = await db
        .selectFrom("submission")
        .selectAll()
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      if (sub) {
        await db
          .updateTable("challenge")
          .set(
            buildChallengeResolvedPatch({
              resolution: v.resolution,
              method: v.method,
              closedAt,
            })
          )
          .where("submission_id", "=", sub.id)
          .where("resolved_at", "is", null)
          .execute();
      }
      break;
    }

    // Published by finalize() when a challenge lapsed with no resolution.
    case "challenge_expired": {
      const chainSubmissionId = String(topic[1]);
      const sub = await db
        .selectFrom("submission")
        .select(["id"])
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      if (sub) {
        // Matched on the missing outcome, not on resolved_at: the keeper's
        // recordTerminalVerdict can close the row before this event is
        // indexed, and it writes the same outcome.
        await db
          .updateTable("challenge")
          .set(buildChallengeExpiredPatch({ closedAt }))
          .where("submission_id", "=", sub.id)
          .where("resolution", "is", null)
          .execute();
      }
      break;
    }

    case "finalized": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { verdict: unknown };
      const sub = await db
        .selectFrom("submission")
        .select(["id"])
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      if (sub) await recordTerminalVerdict(sub.id, fromChainVerdict(v.verdict), txHash, closedAt);
      break;
    }

    case "slashed": {
      const chainSubmissionId = String(topic[1]);
      const v = value as { reexecutor: string; amount: bigint };
      const sub = await db
        .selectFrom("submission")
        .selectAll()
        .where("chain_submission_id", "=", chainSubmissionId)
        .executeTakeFirst();
      const rex = await db
        .selectFrom("reexecutor")
        .selectAll()
        .where("stellar_account", "=", v.reexecutor)
        .executeTakeFirst();
      if (rex) {
        // Read the stake before writing anything. No database connection is
        // held open across a network call, and if this throws nothing has been
        // written yet, so the retry of this event starts from scratch.
        const info = await escrowGateAsKeeper.reexecutor_info({ reexecutor: v.reexecutor });

        // All or nothing: a failure after the insert must roll the insert back,
        // or the retry would find the row, skip the update, and slashed_count
        // would never be corrected.
        await db.transaction().execute(async (trx) => {
          const inserted = await trx
            .insertInto("slashing_event")
            .values({
              reexecutor_id: rex.id,
              submission_id: sub?.id ?? null,
              amount: v.amount.toString(),
              reason: "vote contradicted the bonded re-execution consensus",
              tx_hash: txHash,
            })
            .onConflict((oc) => oc.doNothing())
            .returningAll()
            .executeTakeFirst();
          if (!inserted) return; // event already recorded on an earlier pass

          if (sub) {
            await trx
              .updateTable("replay")
              .set({ slash_tx_hash: txHash })
              .where("submission_id", "=", sub.id)
              .where("reexecutor_id", "=", rex.id)
              .execute();
          }
          await trx
            .updateTable("reexecutor")
            .set({
              // Incremented in SQL, not from the row read above, so two slashes
              // handled close together cannot overwrite each other.
              slashed_count: sql<number>`slashed_count + 1`,
              // Without a fresh read, leave the stored stake alone rather than
              // rewriting it from the stale row.
              ...(info.result
                ? { stake_amount: info.result.stake_amount.toString(), active: info.result.active }
                : {}),
            })
            .where("id", "=", rex.id)
            .execute();
        });
      }
      break;
    }
  }
}


export interface AdoptableSubmission {
  id: string;
  task_type: TaskType;
  escrow_value: string | null;
  min_challenger_bond: string | null;
  challenge_window_s: number;
}

/** Attaches an on-chain submission id to its off-chain draft row, syncs the
 * chain-authoritative timing and bond fields from the contract, and kicks off
 * replay assignment. Idempotent: safe if invoked by both the indexer's
 * submission_created handler and the scheduler's relayed-draft recovery. */
export async function adoptSubmission(
  row: AdoptableSubmission,
  chainSubmissionId: string,
  txHash: string,
  escrowValue?: bigint
): Promise<void> {
  const sub = await readSubmission(chainSubmissionId);
  await db
    .updateTable("submission")
    .set({
      chain_submission_id: chainSubmissionId,
      chain_tx_hash: txHash,
      escrow_value:
        escrowValue !== undefined
          ? escrowValue.toString()
          : sub
            ? sub.escrow_value.toString()
            : row.escrow_value,
      min_challenger_bond: sub ? minChallengerBond(sub).toString() : row.min_challenger_bond,
      challenge_window_s: sub ? Number(sub.challenge_window_s) : row.challenge_window_s,
      // The challenge window runs on ledger time, not on when our row
      // was first drafted — align so the countdown and sweep are exact.
      submitted_at: sub ? new Date(Number(sub.submitted_at) * 1000) : undefined,
      updated_at: new Date(),
    })
    .where("id", "=", row.id)
    .execute();
  await assignReplayJobs({
    submissionId: row.id,
    chainSubmissionId,
    taskType: row.task_type,
  });
}

/** Mirrors invariant 1 off-chain: as soon as a fresh replay tally implies a
 * bonded supermajority, proactively call the real keeper-signed finalize()
 * rather than waiting for the challenge window to elapse. A disputed
 * submission is skipped here — the scheduler resolves its challenge instead. */
export async function maybeEarlyFinalize(submissionRowId: string, chainSubmissionId: string) {
  const sub = await db
    .selectFrom("submission")
    .selectAll()
    .where("id", "=", submissionRowId)
    .executeTakeFirst();
  if (!sub || sub.status !== "pending") return;
  const record = await readSubmission(chainSubmissionId);
  if (!record || record.finalized || !consensusOutcome(record)) return;

  const { status, txHash } = await finalizeOnChain(chainSubmissionId);
  await recordTerminalVerdict(submissionRowId, status, txHash);
}

/** Consecutive deterministic failures on the same event, so one permanently
 * unprocessable event cannot wedge the indexer forever. Transient failures
 * (network, database or RPC unavailable) never count: the event is retried
 * until the dependency recovers, because skipping it would lose a verdict. */
let stuckEvent: { id: string; failures: number } | null = null;
const MAX_EVENT_RETRIES = 5;

export async function pollOnce(): Promise<number> {
  const cursor = await getCursor();
  const filters = [{ type: "contract" as const, contractIds: [CONTRACT_ID] }];

  let res;
  try {
    res = await server.getEvents(
      cursor.pagingToken
        ? { filters, cursor: cursor.pagingToken, limit: PAGE_SIZE }
        : { filters, startLedger: cursor.ledger, limit: PAGE_SIZE }
    );
  } catch (err) {
    // The RPC only retains ~7 days of events. A cursor older than that (the
    // backend was down for a while) is rejected outright on every poll, so
    // restart from the oldest retained ledger; the scheduler's on-chain
    // reconcile pass repairs any verdicts whose events were missed.
    const health = await server.getHealth();
    if (cursor.ledger < health.oldestLedger || cursor.ledger > health.latestLedger) {
      const restart = Math.min(Math.max(cursor.ledger, health.oldestLedger + 10), health.latestLedger);
      console.warn(`[indexer] cursor ledger ${cursor.ledger} outside RPC retention, restarting from ${restart}`);
      await setCursor(restart, null);
      return 0;
    }
    throw err;
  }

  let processed = 0;
  for (const ev of res.events) {
    let topic: unknown[] = [];
    try {
      topic = ev.topic.map((t) => scValToNative(t));
      const value = scValToNative(ev.value);
      const closedAt = parseLedgerClosedAt(ev.ledgerClosedAt, { id: ev.id, ledger: ev.ledger });
      await handleEvent(topic, value, ev.ledger, ev.txHash, closedAt);
      stuckEvent = null;
    } catch (err) {
      if (isTransientError(err)) throw err;
      const failures = stuckEvent?.id === ev.id ? stuckEvent.failures + 1 : 1;
      stuckEvent = { id: ev.id, failures };
      if (failures < MAX_EVENT_RETRIES) throw err;
      const eventName = topic[0] !== undefined && topic[0] !== null ? String(topic[0]) : "undecodable";
      console.error(`[indexer] skipping event ${ev.id} (ledger ${ev.ledger}, ${eventName}) after ${failures} failures:`, err);
      stuckEvent = null;
    }
    // Persist per event: a failure mid-page resumes after the last success.
    await setCursor(ev.ledger, ev.id);
    processed++;
  }

  // Empty/short pages still return a cursor marking how far the RPC scanned.
  if (res.cursor && res.events.length < PAGE_SIZE) {
    await setCursor(ledgerOfPagingToken(res.cursor), res.cursor);
  }
  return processed;
}

/** Self-rescheduling, never overlapping: a slow poll (e.g. one that submits
 * a finalize tx and waits ~3-5s for confirmation) must fully finish before
 * the next tick starts, or two ticks can both observe the same unprocessed
 * event and race to finalize the same submission concurrently. */
export function startIndexer(intervalMs = 4000): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    let delay = intervalMs;
    try {
      // A full page means more events are already waiting (a backlog after
      // downtime), so poll again at once; only a short page means caught up.
      if ((await pollOnce()) >= PAGE_SIZE) delay = 0;
    } catch (err) {
      console.error("[indexer] poll failed:", err);
    }
    if (!stopped) timer = setTimeout(tick, delay);
  };
  timer = setTimeout(tick, 0);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
