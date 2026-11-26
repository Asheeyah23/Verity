import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { SubmissionStatus, TaskType } from "@verity/db";
import type { ConfigRecord } from "escrow-gate";
import { db } from "../../db.js";
import { env } from "../../config/env.js";
import { getGateConfig } from "../../chain/config.js";

/** A retrieval submission gets a full quorum only when it was actually escalated:
 * its spot-check mismatched, a challenge was opened, or the agent was flagged. */
export function needsFullQuorum(sub: {
  task_type: TaskType;
  status: SubmissionStatus;
  full_replay_requested_at?: Date | string | null;
}): boolean {
  return (
    sub.task_type === "deterministic" ||
    sub.status === "disputed" ||
    sub.full_replay_requested_at != null
  );
}

/** The contract's live rules for who may cast a counting vote. */
export interface VoteEligibility {
  allowlist: boolean;
  /** EscrowGate's current min_stake_floor (i128, in stroops). */
  minStakeFloor: bigint;
}

/** The vote-eligibility part of EscrowGate's live config. */
export function eligibilityFrom(
  cfg: Pick<ConfigRecord, "reexecutor_allowlist" | "min_stake_floor">
): VoteEligibility {
  return { allowlist: cfg.reexecutor_allowlist, minStakeFloor: BigInt(cfg.min_stake_floor) };
}

/** The contract's live voting rules, as far as assignment needs them. */
async function votingRules(): Promise<{ quorum: number; eligibility: VoteEligibility }> {
  const cfg = await getGateConfig();
  return { quorum: Number(cfg.quorum_min_reexecutors), eligibility: eligibilityFrom(cfg) };
}

/** Parses a mirrored `numeric` stake into a bigint. Anything that is not a
 * whole number of stroops is treated as unknown (null), never as zero. */
function parseStake(stake: string | bigint): bigint | null {
  if (typeof stake === "bigint") return stake;
  const m = /^\s*(-?\d+)(?:\.0*)?\s*$/.exec(stake);
  return m ? BigInt(m[1]) : null;
}

/**
 * Whether a re-executor row can cast a vote the contract will count, judged by
 * the contract's *current* rules. The mirrored `active` flag alone is not
 * enough: the contract recomputes it only when stake changes, so after an admin
 * raises min_stake_floor an account below the new floor still reads
 * `active = true`, yet attest_replay rejects it (`stake_amount <
 * min_stake_floor`). The comparison is done in bigint, so i128 values above
 * 2^53 compare exactly.
 */
export function canCastVote(
  row: { active: boolean; approved: boolean; stake_amount: string | bigint },
  rules: VoteEligibility
): boolean {
  if (!row.active) return false;
  if (rules.allowlist && !row.approved) return false;
  const stake = parseStake(row.stake_amount);
  return stake !== null && stake >= rules.minStakeFloor;
}

export function assignmentSeed(submissionId: string, chainSubmissionId: string): string {
  return createHash("sha256").update(`${submissionId}|${chainSubmissionId}`).digest("hex");
}

export function rankBySeed<T extends { stellar_account: string }>(seed: string, rows: T[]): T[] {
  return rows
    .map((r) => ({ r, rank: createHash("sha256").update(`${seed}|${r.stellar_account}`).digest("hex") }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map(({ r }) => r);
}

/**
 * Re-executors that can actually cast a counting vote right now, in this
 * submission's deterministic order: staked at or above the contract's live
 * min_stake_floor, approved when the contract runs an allow-list, and with a
 * worker that polled for work recently. Ranking is by sha256(seed + account);
 * the seed is stored on each replay row so anyone can reproduce the selection.
 *
 * Liveness matters because an assignment is a claim on a quorum seat: handing
 * one to an account that staked but runs no worker costs the submission its
 * consensus. Ranking is uniform, not stake-weighted.
 *
 * The SQL filter compares stake_amount as numeric against the floor bound as
 * numeric (never as text, never through a JS number). canCastVote() re-checks
 * each row with the same rule so the two can never drift apart.
 */
async function rankedLiveReexecutors(seed: string, rules: VoteEligibility) {
  let qb = db
    .selectFrom("reexecutor")
    .select(["id", "stellar_account", "active", "approved", "stake_amount"])
    .where("active", "=", true)
    .where(sql<boolean>`stake_amount >= ${rules.minStakeFloor.toString()}::numeric`)
    .where("last_seen_at", ">", sql<Date>`now() - (${env.REEXECUTOR_LIVENESS_S} || ' seconds')::interval`);
  if (rules.allowlist) qb = qb.where("approved", "=", true);
  const live = (await qb.execute()).filter((r) => canCastVote(r, rules));
  return rankBySeed(seed, live);
}

/** Adds up to `count` re-executors who hold no row yet in `table` for this
 * submission, in ranked order. Returns how many were added. */
async function assignNext(
  table: "replay" | "spot_check",
  submissionId: string,
  seed: string,
  rules: VoteEligibility,
  count: number
): Promise<number> {
  if (count <= 0) return 0;
  const taken = new Set(
    (
      await db.selectFrom(table).select("reexecutor_id").where("submission_id", "=", submissionId).execute()
    ).map((row) => row.reexecutor_id)
  );
  const next = (await rankedLiveReexecutors(seed, rules)).filter((r) => !taken.has(r.id)).slice(0, count);
  for (const r of next) {
    if (table === "replay") {
      await db
        .insertInto("replay")
        .values({ submission_id: submissionId, reexecutor_id: r.id, assignment_seed: seed })
        .onConflict((oc) => oc.columns(["submission_id", "reexecutor_id"]).doNothing())
        .execute();
    } else {
      await db
        .insertInto("spot_check")
        .values({ submission_id: submissionId, reexecutor_id: r.id })
        .onConflict((oc) => oc.columns(["submission_id", "reexecutor_id"]).doNothing())
        .execute();
    }
  }
  return next.length;
}

/**
 * First assignment for a new submission. A deterministic task (or any task
 * forced to a full quorum) gets the contract's quorum plus REPLAY_OVERASSIGN
 * spare re-executors: the contract counts any eligible vote, so a spare costs
 * nothing and keeps one slow worker from stalling the verdict. A retrieval
 * task gets a single sampled spot-checker.
 *
 * If nobody is online nothing is assigned here; topUpAssignments() picks the
 * submission up as soon as somebody is.
 */
export function replayWantCount(quorum: number, overassign: number, held: number): number {
  return quorum + overassign - held;
}

export async function assignReplayJobs(params: {
  submissionId: string;
  chainSubmissionId: string;
  taskType: TaskType;
  /** Force a full replay quorum even for a retrieval task — used when a
   * spot-check mismatches or a challenge is opened, where a single sampled
   * vote can never reach on-chain consensus on its own. */
  fullQuorum?: boolean;
}) {
  if (params.taskType === "unverifiable") return;
  const { quorum, eligibility } = await votingRules();
  const seed = assignmentSeed(params.submissionId, params.chainSubmissionId);

  if (params.taskType === "deterministic" || params.fullQuorum) {
    const held = await db
      .selectFrom("replay")
      .select(sql<string>`count(*)`.as("count"))
      .where("submission_id", "=", params.submissionId)
      .where("status", "!=", "missed")
      .executeTakeFirst();
    const want = replayWantCount(quorum, env.REPLAY_OVERASSIGN, Number(held?.count ?? 0));
    await assignNext("replay", params.submissionId, seed, eligibility, want);
  } else {
    await assignNext("spot_check", params.submissionId, seed, eligibility, 1);
  }
}

/** Escalates a submission to a full replay quorum. Idempotent: re-executors
 * that already hold a replay row (assigned or attested) are left untouched. */
export async function escalateToFullReplay(submissionId: string) {
  const sub = await db
    .selectFrom("submission")
    .selectAll()
    .where("id", "=", submissionId)
    .executeTakeFirst();
  if (!sub?.chain_submission_id) return;
  if (!sub.full_replay_requested_at) {
    await db
      .updateTable("submission")
      .set({ full_replay_requested_at: new Date() })
      .where("id", "=", submissionId)
      .where("full_replay_requested_at", "is", null)
      .execute();
  }
  await assignReplayJobs({
    submissionId: sub.id,
    chainSubmissionId: sub.chain_submission_id,
    taskType: sub.task_type,
    fullQuorum: true,
  });
}

/** PRD §5: a spot-check mismatch "flags every other unverified submission
 * from that agent for review" — here, review means a full replay quorum
 * instead of the sampled spot-check they would otherwise have received. */
export async function escalateAgentPendingSubmissions(agentId: string, exceptSubmissionId: string) {
  const others = await db
    .selectFrom("submission")
    .select(["id"])
    .where("agent_id", "=", agentId)
    .where("status", "=", "pending")
    .where("chain_submission_id", "is not", null)
    .where("id", "!=", exceptSubmissionId)
    .execute();
  for (const other of others) {
    await escalateToFullReplay(other.id);
  }
}

/**
 * Keeps every open submission supplied with enough working re-executors to
 * reach quorum. An assignment still unanswered after REPLAY_REASSIGN_AFTER_S
 * stops counting — its re-executor may be offline — and the next-ranked live
 * one is asked as well. The slow one's row stays, and its vote still counts
 * if it arrives. Returns how many assignments were added.
 */
export async function topUpAssignments(): Promise<number> {
  const open = await db
    .selectFrom("submission")
    .select(["id", "chain_submission_id", "task_type", "status", "full_replay_requested_at"])
    .where("status", "in", ["pending", "disputed"])
    .where("chain_submission_id", "is not", null)
    // Once the window has closed on an unchallenged submission the sweep
    // finalizes it; a vote arriving after that would be rejected anyway.
    .where((eb) =>
      eb.or([
        eb("status", "=", "disputed"),
        sql<boolean>`submitted_at + (challenge_window_s || ' seconds')::interval > now()`,
      ])
    )
    .execute();
  if (open.length === 0) return 0;

  const { quorum, eligibility } = await votingRules();
  const freshSince = sql<Date>`now() - (${env.REPLAY_REASSIGN_AFTER_S} || ' seconds')::interval`;
  let added = 0;

  for (const sub of open) {
    const seed = assignmentSeed(sub.id, sub.chain_submission_id!);
    const replays = await db
      .selectFrom("replay")
      .select([
        sql<string>`count(*) filter (where status = 'confirmed_onchain')`.as("confirmed"),
        sql<string>`count(*) filter (where status = 'assigned' and assigned_at > ${freshSince})`.as("fresh"),
        sql<string>`count(*)`.as("total"),
      ])
      .where("submission_id", "=", sub.id)
      .executeTakeFirst();

    if (needsFullQuorum(sub)) {
      const working = Number(replays?.confirmed ?? 0) + Number(replays?.fresh ?? 0);
      added += await assignNext("replay", sub.id, seed, eligibility, quorum - working);
      continue;
    }

    // Retrieval, not escalated: one spot-check answer is all it needs.
    const spot = await db
      .selectFrom("spot_check")
      .select([
        sql<string>`count(*) filter (where result is not null)`.as("answered"),
        sql<string>`count(*) filter (where result is null and sampled_at > ${freshSince})`.as("fresh"),
      ])
      .where("submission_id", "=", sub.id)
      .executeTakeFirst();
    if (Number(spot?.answered ?? 0) === 0 && Number(spot?.fresh ?? 0) === 0) {
      added += await assignNext("spot_check", sub.id, seed, eligibility, 1);
    }
  }
  return added;
}
