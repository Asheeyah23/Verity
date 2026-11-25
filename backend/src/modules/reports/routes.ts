import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "../../db.js";

export function buildVerificationRatesQuery(marketplaceId?: string) {
  let qb = db
    .selectFrom("submission")
    .innerJoin("marketplace", "marketplace.id", "submission.marketplace_id")
    .select([
      "submission.marketplace_id",
      "marketplace.name as marketplace_name",
      "marketplace.stellar_account as marketplace_account",
      "submission.task_type",
      "submission.status",
      sql<string>`count(*)`.as("count"),
    ])
    // A draft whose submit() was never signed does not exist on-chain and
    // is not a submission; counting it would disagree with every list.
    .where("submission.chain_submission_id", "is not", null)
    .groupBy([
      "submission.marketplace_id",
      "marketplace.name",
      "marketplace.stellar_account",
      "submission.task_type",
      "submission.status",
    ]);
  if (marketplaceId) {
    qb = qb.where("submission.marketplace_id", "=", marketplaceId);
  }
  return qb;
}

export function buildSlashingEventsCountQuery(marketplaceId?: string) {
  let qb = db
    .selectFrom("slashing_event")
    .select(sql<string>`count(*)`.as("count"));
  if (marketplaceId) {
    // slashing_event.submission_id is nullable. Slashing events without
    // an associated submission are only counted in the unfiltered total.
    qb = qb
      .innerJoin("submission", "submission.id", "slashing_event.submission_id")
      .where("submission.marketplace_id", "=", marketplaceId);
  }
  return qb;
}

export async function reportsRoutes(app: FastifyInstance) {
  app.get("/v1/reports/verification-rates", async (req) => {
    const query = z.object({ marketplace_id: z.string().uuid().optional() }).parse(req.query);
    const rows = await buildVerificationRatesQuery(query.marketplace_id).execute();
    const slashCount = await buildSlashingEventsCountQuery(query.marketplace_id).executeTakeFirst();

    return {
      by_marketplace_task_status: rows,
      slashing_events_total: Number(slashCount?.count ?? 0),
      // The PRD's false-accept-rate metric depends on a manual audit sample
      // against real-world ground truth — it is not something this system
      // can compute on its own, so it is reported here as null rather than
      // fabricated, pending a manual audit workflow.
      false_accept_rate: null,
    };
  });
}
