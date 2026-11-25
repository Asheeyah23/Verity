import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { env } from "../../config/env.js";
import { escrowGateFor, escrowGateAsKeeper } from "../../chain/clients.js";
import { assertGateCall, assertSimulated, buildWithAccountCheck, relaySignedXdr } from "../../chain/rpc.js";
import { getGateConfig } from "../../chain/config.js";

const positiveStroops = z.string().regex(/^[1-9]\d*$/, "must be a positive integer amount in stroops");

interface ReexecutorStats {
  /** Votes this re-executor put on-chain. */
  attested: number;
  /** Of those, votes on the side a bonded consensus settled on. */
  agreed: number;
  /** Votes a bonded consensus proved wrong. */
  disagreed: number;
  /** Assignments the submission was finalized without. */
  missed: number;
}

const NO_STATS: ReexecutorStats = { attested: 0, agreed: 0, disagreed: 0, missed: 0 };

/** A re-executor's track record, counted from its recorded assignments and
 * the on-chain outcome of each submission. Only a verdict reached by bonded
 * consensus says anything about whether a vote was right; a window that
 * elapsed does not, so those votes count as attested and nothing more. */
async function statsByReexecutor(reexecutorId?: string): Promise<Map<string, ReexecutorStats>> {
  const onRightSide = sql<boolean>`(replay.match and submission.status = 'verified') or (not replay.match and submission.status = 'slashed')`;
  const settledByConsensus = sql<boolean>`replay.status = 'confirmed_onchain' and submission.resolution_method = 'reexecution_consensus' and submission.status in ('verified','slashed')`;
  let qb = db
    .selectFrom("replay")
    .innerJoin("submission", "submission.id", "replay.submission_id")
    .select([
      "replay.reexecutor_id",
      sql<string>`count(*) filter (where replay.status = 'confirmed_onchain')`.as("attested"),
      sql<string>`count(*) filter (where ${settledByConsensus} and (${onRightSide}))`.as("agreed"),
      sql<string>`count(*) filter (where ${settledByConsensus} and not (${onRightSide}))`.as("disagreed"),
      sql<string>`count(*) filter (where replay.status = 'missed')`.as("missed"),
    ])
    .groupBy("replay.reexecutor_id");
  if (reexecutorId) qb = qb.where("replay.reexecutor_id", "=", reexecutorId);
  const rows = await qb.execute();
  return new Map(
    rows.map((r) => [
      r.reexecutor_id,
      {
        attested: Number(r.attested),
        agreed: Number(r.agreed),
        disagreed: Number(r.disagreed),
        missed: Number(r.missed),
      },
    ])
  );
}

type ReexecutorRow = Awaited<ReturnType<typeof loadReexecutor>>;
function loadReexecutor(id: string) {
  return db.selectFrom("reexecutor").selectAll().where("id", "=", id).executeTakeFirst();
}

/** What the API says about a re-executor. `reputation_score` is left out:
 * nothing computes it, and a constant is not a reputation. `online` and
 * `can_vote` are derived from real state — the worker's last poll, and the
 * contract's own eligibility rules. */
function present(row: NonNullable<ReexecutorRow>, stats: ReexecutorStats, allowlist: boolean) {
  const { reputation_score: _unused, ...rest } = row;
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : null;
  return {
    ...rest,
    online: lastSeen !== null && Date.now() - lastSeen < env.REEXECUTOR_LIVENESS_S * 1000,
    can_vote: row.active && (!allowlist || row.approved),
    stats,
  };
}

/** Mirrors an account's real on-chain stake and approval into its row. */
async function mirrorFromChain(account: string) {
  const info = (await escrowGateAsKeeper.reexecutor_info({ reexecutor: account })).result;
  if (!info) return null;
  return { stake_amount: info.stake_amount.toString(), active: info.active, approved: info.approved };
}

export async function reexecutorsRoutes(app: FastifyInstance) {
  // Anyone may stake: build-sign-relay-confirm, we never touch the caller's
  // key, only build the unsigned stake transaction. Whether a staked account
  // may also vote is the contract's rule (see `can_vote`).
  app.post("/v1/reexecutors", { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ stake_amount: positiveStroops }).parse(req.body);
    const account = req.stellarAccount!;

    // Build and simulate before touching the DB, so a stake the contract
    // would reject never leaves a phantom re-executor row behind.
    const client = escrowGateFor(account);
    const assembled = await buildWithAccountCheck(() =>
      client.register_reexecutor({
        reexecutor: account,
        stake_amount: BigInt(body.stake_amount),
      })
    );
    assertSimulated(assembled);
    const unsignedXdr = assembled.toXDR();

    // onConflict, not select-then-insert: a double submit would otherwise
    // lose the race on the unique stellar_account and answer 500.
    await db
      .insertInto("reexecutor")
      .values({
        stellar_account: account,
        // Nothing is staked until the signed transaction lands; the
        // relay step (and the indexer) fill in the real on-chain amount.
        // Until then the row is not listed.
        stake_amount: "0",
        stake_asset: "native",
      })
      .onConflict((oc) => oc.column("stellar_account").doNothing())
      .execute();
    const row = await db
      .selectFrom("reexecutor")
      .selectAll()
      .where("stellar_account", "=", account)
      .executeTakeFirstOrThrow();

    reply.code(201);
    return { reexecutor: row, unsigned_transaction_xdr: unsignedXdr };
  });

  // Build an unsigned withdraw_stake transaction for the caller's own stake.
  // The contract refuses to let stake drop below the floor while any of the
  // caller's votes sits on an unfinalized submission.
  app.post("/v1/reexecutors/:id/withdraw", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ amount: positiveStroops }).parse(req.body);
    const row = await loadReexecutor(params.id);
    if (!row || row.stellar_account !== req.stellarAccount) {
      reply.code(403);
      return { error: "forbidden" };
    }
    const assembled = await buildWithAccountCheck(() =>
      escrowGateFor(row.stellar_account).withdraw_stake({
        reexecutor: row.stellar_account,
        amount: BigInt(body.amount),
      })
    );
    assertSimulated(assembled);
    reply.code(201);
    return { reexecutor: row, unsigned_transaction_xdr: assembled.toXDR() };
  });

  // An account that staked directly on-chain (e.g. scripts/bootstrap_reexecutors.sh),
  // or before this backend's event-retention horizon, has no row here yet.
  // This mirrors its real on-chain stake into Postgres — it reads the chain,
  // it never moves funds.
  app.post("/v1/reexecutors/sync", { preHandler: requireAuth }, async (req, reply) => {
    const account = req.stellarAccount!;
    const onChain = await mirrorFromChain(account);
    if (!onChain) {
      reply.code(404);
      return { error: "this account has no stake on EscrowGate — register via POST /v1/reexecutors first" };
    }
    const row = await db
      .insertInto("reexecutor")
      .values({ stellar_account: account, stake_asset: "native", ...onChain })
      .onConflict((oc) => oc.column("stellar_account").doUpdateSet(onChain))
      .returningAll()
      .executeTakeFirstOrThrow();
    return { reexecutor: row };
  });

  // Relays a signed stake or withdrawal for the caller's own account, then
  // reads the result back from the contract.
  app.post("/v1/reexecutors/:id/relay", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ signed_transaction_xdr: z.string().min(1) }).parse(req.body);
    const row = await loadReexecutor(params.id);
    if (!row || row.stellar_account !== req.stellarAccount) {
      reply.code(403);
      return { error: "forbidden" };
    }
    const call = assertGateCall(body.signed_transaction_xdr, {
      account: row.stellar_account,
      fns: ["register_reexecutor", "withdraw_stake"],
    });
    const { hash } = await relaySignedXdr(body.signed_transaction_xdr);
    const onChain = await mirrorFromChain(row.stellar_account);

    const updated = await db
      .updateTable("reexecutor")
      .set({
        ...(onChain ?? { active: false }),
        ...(call.fn === "register_reexecutor" ? { chain_stake_tx_hash: hash } : {}),
      })
      .where("id", "=", params.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return { reexecutor: updated, tx_hash: hash };
  });

  app.get("/v1/reexecutors/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await loadReexecutor(params.id);
    if (!row) {
      reply.code(404);
      return { error: "not found" };
    }
    const slashes = await db
      .selectFrom("slashing_event")
      .leftJoin("submission", "submission.id", "slashing_event.submission_id")
      .selectAll("slashing_event")
      .select("submission.chain_submission_id")
      .where("slashing_event.reexecutor_id", "=", params.id)
      .orderBy("slashing_event.created_at", "desc")
      .execute();
    const [stats, cfg] = await Promise.all([statsByReexecutor(params.id), getGateConfig()]);
    return {
      reexecutor: present(row, stats.get(row.id) ?? NO_STATS, cfg.reexecutor_allowlist),
      slashing_events: slashes,
    };
  });

  app.get("/v1/reexecutors", async () => {
    const rows = await db
      .selectFrom("reexecutor")
      .selectAll()
      // A row created for a stake transaction that was never signed is not a
      // re-executor. One that staked and later withdrew or was slashed is.
      .where((eb) =>
        eb.or([
          eb("stake_amount", ">", "0"),
          eb("slashed_count", ">", 0),
          eb("chain_stake_tx_hash", "is not", null),
        ])
      )
      .orderBy("stake_amount", "desc")
      .orderBy("joined_at")
      .execute();
    const [stats, cfg] = await Promise.all([statsByReexecutor(), getGateConfig()]);
    return rows.map((row) => present(row, stats.get(row.id) ?? NO_STATS, cfg.reexecutor_allowlist));
  });

  // Liveness signal that does not depend on the work loop: a worker busy on
  // a slow replay cannot poll for assignments, and would otherwise age out of
  // REEXECUTOR_LIVENESS_S and stop receiving work. Like the poll, it writes
  // last_seen_at only for the worker's own account, so "online" still means a
  // worker is really running, not merely that the account once staked.
  app.post("/v1/reexecutors/:id/heartbeat", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const updated = await db
      .updateTable("reexecutor")
      .set({ last_seen_at: new Date() })
      .where("id", "=", params.id)
      .where("stellar_account", "=", req.stellarAccount!)
      .returning("id")
      .executeTakeFirst();
    if (!updated) {
      reply.code(403);
      return { error: "forbidden" };
    }
    reply.code(204);
  });

  // Internal addition (beyond the PRD's literal §9 list): lets a
  // reexecutor-agent worker poll for work assigned to it, authenticated as
  // itself via the same SEP-10 JWT. This poll also writes last_seen_at, as
  // does the heartbeat, so "online" means a worker is really asking for work,
  // not merely that the account once staked.
  app.get("/v1/reexecutors/:id/assignments", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await loadReexecutor(params.id);
    if (!row || row.stellar_account !== req.stellarAccount) {
      reply.code(403);
      return { error: "forbidden" };
    }
    await db.updateTable("reexecutor").set({ last_seen_at: new Date() }).where("id", "=", params.id).execute();
    const replayAssignments = await db
      .selectFrom("replay")
      .innerJoin("submission", "submission.id", "replay.submission_id")
      .selectAll("replay")
      .select(["submission.task_type", "submission.input_ref", "submission.function_ref", "submission.claimed_output_hash", "submission.chain_submission_id"])
      .where("replay.reexecutor_id", "=", params.id)
      .where("replay.status", "=", "assigned")
      .where("submission.status", "in", ["pending", "disputed"])
      .execute();
    const spotCheckAssignments = await db
      .selectFrom("spot_check")
      .innerJoin("submission", "submission.id", "spot_check.submission_id")
      .selectAll("spot_check")
      .select(["submission.task_type", "submission.input_ref", "submission.function_ref", "submission.claimed_output_hash", "submission.chain_submission_id"])
      .where("submission.status", "in", ["pending", "disputed"])
      .where("spot_check.reexecutor_id", "=", params.id)
      .where("spot_check.result", "is", null)
      .execute();
    return { replay_assignments: replayAssignments, spot_check_assignments: spotCheckAssignments };
  });
}
