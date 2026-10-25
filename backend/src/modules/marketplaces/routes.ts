import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { HttpError } from "../../http-error.js";
import { assertPublicHttpUrl } from "../webhooks/url-guard.js";

/** The events the backend actually dispatches. Keep in step with the
 * indexer (disputed) and verdict.ts (verified, slashed). */
export const WEBHOOK_EVENTS = ["submission.verified", "submission.slashed", "submission.disputed"] as const;

/** Every verdict event is delivered to each matching subscription, so the
 * number of subscriptions bounds the outbound requests one event can cause. */
export const MAX_WEBHOOKS_PER_MARKETPLACE = 10;

const webhookColumns = ["id", "url", "events", "active", "created_at"] as const;

/** True when the caller owns the marketplace; otherwise sets the 403 reply. */
async function ownsMarketplace(marketplaceId: string, account: string | undefined, reply: FastifyReply) {
  const marketplace = await db
    .selectFrom("marketplace")
    .select(["stellar_account"])
    .where("id", "=", marketplaceId)
    .executeTakeFirst();
  if (!marketplace || marketplace.stellar_account !== account) {
    reply.code(403);
    return false;
  }
  return true;
}

const notOwnerError = { error: "only the marketplace's own account can manage its webhooks" };

async function upsertMarketplace(account: string, name: string) {
  const inserted = await db
    .insertInto("marketplace")
    .values({ stellar_account: account, name })
    .onConflict((oc) => oc.column("stellar_account").doNothing())
    .returningAll()
    .executeTakeFirst();

  if (inserted) {
    return { row: inserted, created: true };
  }

  const existing = await db
    .selectFrom("marketplace")
    .selectAll()
    .where("stellar_account", "=", account)
    .executeTakeFirstOrThrow();

  return { row: existing, created: false };
}

export async function marketplacesRoutes(app: FastifyInstance) {
  app.post("/v1/marketplaces", { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    const account = req.stellarAccount!;
    const { row, created } = await upsertMarketplace(account, body.name);
    if (created) {
      reply.code(201);
    }
    return row;
  });

  app.post("/v1/marketplaces/:id/webhooks", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        url: z.string().url().max(2048),
        secret: z.string().min(8).max(256),
        events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
      })
      .parse(req.body);
    if (!(await ownsMarketplace(params.id, req.stellarAccount, reply))) return notOwnerError;
    await assertPublicHttpUrl(body.url);
    const { count } = await db
      .selectFrom("webhook_subscription")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("marketplace_id", "=", params.id)
      .executeTakeFirstOrThrow();
    if (Number(count) >= MAX_WEBHOOKS_PER_MARKETPLACE) {
      throw new HttpError(
        409,
        `a marketplace can have at most ${MAX_WEBHOOKS_PER_MARKETPLACE} webhook subscriptions; deactivating one does not free its slot`
      );
    }
    const row = await db
      .insertInto("webhook_subscription")
      .values({
        marketplace_id: params.id,
        url: body.url,
        secret: body.secret,
        events: [...new Set(body.events)],
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    reply.code(201);
    return row;
  });

  // Explicit columns: selectAll() would leak each subscription's secret.
  app.get("/v1/marketplaces/:id/webhooks", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await ownsMarketplace(params.id, req.stellarAccount, reply))) return notOwnerError;
    return db
      .selectFrom("webhook_subscription")
      .select([...webhookColumns])
      .where("marketplace_id", "=", params.id)
      .orderBy("created_at")
      .execute();
  });

  app.patch("/v1/marketplaces/:id/webhooks/:webhookId", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid(), webhookId: z.string().uuid() }).parse(req.params);
    const body = z.object({ active: z.boolean() }).parse(req.body);
    if (!(await ownsMarketplace(params.id, req.stellarAccount, reply))) return notOwnerError;
    const row = await db
      .updateTable("webhook_subscription")
      .set({ active: body.active })
      .where("id", "=", params.webhookId)
      .where("marketplace_id", "=", params.id)
      .returning([...webhookColumns])
      .executeTakeFirst();
    if (!row) {
      reply.code(404);
      return { error: "webhook not found" };
    }
    return row;
  });
}

export async function findOrCreateMarketplaceForAccount(account: string) {
  const { row } = await upsertMarketplace(account, account);
  return row;
}
