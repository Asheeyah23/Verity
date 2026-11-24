import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { escrowGateFor } from "../../chain/clients.js";
import { assertGateCall, assertSimulated, buildWithAccountCheck, relaySignedXdr } from "../../chain/rpc.js";

export async function challengesRoutes(app: FastifyInstance) {
  // Read-only list addition (same rationale as GET /v1/submissions above) so
  // the /challenges dashboard page has a real feed of open and resolved
  // challenges, joined with enough submission context to be useful, instead
  // of one-at-a-time lookups with no discovery path.
  app.get("/v1/challenges", async (req, reply) => {
    const query = z
      .object({
        resolved: z.enum(["true", "false"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    // Join and filters only: the page and the total are both derived from
    // this, so the total counts exactly the rows the filters page through.
    let filtered = db
      .selectFrom("challenge")
      .innerJoin("submission", "submission.id", "challenge.submission_id");
    if (query.resolved === "true") filtered = filtered.where("challenge.resolved_at", "is not", null);
    if (query.resolved === "false") filtered = filtered.where("challenge.resolved_at", "is", null);
    const page = filtered
      .select([
        "challenge.id",
        "challenge.submission_id",
        "challenge.challenger_account",
        "challenge.challenger_bond",
        "challenge.opened_at",
        "challenge.resolved_at",
        "challenge.resolution",
        "challenge.resolution_method",
        "challenge.chain_tx_hash",
        "submission.escrow_ref",
        "submission.task_type",
        "submission.status",
        "submission.chain_submission_id",
      ])
      .orderBy("challenge.opened_at", "desc")
      .orderBy("challenge.id")
      .limit(limit)
      .offset(offset);
    const [rows, { total }] = await Promise.all([
      page.execute(),
      filtered.select((eb) => eb.fn.countAll().as("total")).executeTakeFirstOrThrow(),
    ]);
    // Postgres returns count(*) as a bigint string. The body stays a bare
    // array so existing clients keep working; paging metadata is in headers.
    reply.header("x-total-count", String(Number(total)));
    reply.header("x-limit", String(limit));
    reply.header("x-offset", String(offset));
    return rows;
  });

  app.post("/v1/submissions/:id/challenge", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ bond: z.string().regex(/^[1-9]\d*$/, "must be a positive integer amount in stroops") }).parse(req.body);
    const challenger = req.stellarAccount!;

    const submission = await db
      .selectFrom("submission")
      .selectAll()
      .where("id", "=", params.id)
      .executeTakeFirst();
    if (!submission?.chain_submission_id) {
      reply.code(404);
      return { error: "submission not found or not yet confirmed on-chain" };
    }

    const chainSubmissionId = submission.chain_submission_id;
    const client = escrowGateFor(challenger);
    const assembled = await buildWithAccountCheck(() =>
      client.open_challenge({
        challenger,
        submission_id: BigInt(chainSubmissionId),
        bond: BigInt(body.bond),
      })
    );
    assertSimulated(assembled);

    reply.code(201);
    return { unsigned_transaction_xdr: assembled.toXDR() };
  });

  app.post("/v1/submissions/:id/challenge/relay", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ signed_transaction_xdr: z.string().min(1) }).parse(req.body);
    const submission = await db
      .selectFrom("submission")
      .select(["chain_submission_id"])
      .where("id", "=", params.id)
      .executeTakeFirst();
    if (!submission?.chain_submission_id) {
      reply.code(404);
      return { error: "submission not found or not yet confirmed on-chain" };
    }
    // Only the caller's own open_challenge on this very submission is relayed.
    const chainId = BigInt(submission.chain_submission_id);
    assertGateCall(body.signed_transaction_xdr, {
      account: req.stellarAccount!,
      fns: ["open_challenge"],
      check: (call) => (call.args[1] === chainId ? null : "signed transaction challenges a different submission"),
    });
    const { hash } = await relaySignedXdr(body.signed_transaction_xdr);
    return { tx_hash: hash, note: "chain indexer will reconcile the challenge row from the on-chain event" };
  });
}
