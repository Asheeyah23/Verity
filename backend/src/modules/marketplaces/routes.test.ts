import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { CompiledQuery, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, QueryResult } from "kysely";
import type { Database } from "@verity/db";

const keeper = Keypair.random();
const server = Keypair.random();
const owner = Keypair.random();
const nonOwner = Keypair.random();
const passphrase = "Test SDF Network ; September 2015";
const homeDomain = "localhost";
const webAuthDomain = "localhost:3001";
const jwtSecret = "a".repeat(32);

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: passphrase,
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: keeper.secret(),
  SEP10_SIGNING_SECRET: server.secret(),
  JWT_SECRET: jwtSecret,
  WEB_AUTH_DOMAIN: webAuthDomain,
  HOME_DOMAIN: homeDomain,
});

import { HttpError } from "../../http-error.js";
import { ZodError } from "zod";

const { marketplacesRoutes, WEBHOOK_EVENTS, createWebhookBody } = await import("./routes.js");
const { issueJwt } = await import("../../auth/sep10.js");

class MockDriver {
  private handler: (query: CompiledQuery) => Promise<QueryResult<any>>;
  constructor(handler: (query: CompiledQuery) => Promise<QueryResult<any>>) {
    this.handler = handler;
  }
  async init() {}
  async acquireConnection() {
    return {
      executeQuery: async (compiledQuery: CompiledQuery) => this.handler(compiledQuery),
      async *streamQuery() {},
    };
  }
  async beginTransaction() {}
  async commitTransaction() {}
  async rollbackTransaction() {}
  async releaseConnection() {}
  async destroy() {}
}

function createMockDb(handler: (query: CompiledQuery) => Promise<QueryResult<any>>): Kysely<Database> {
  return new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new MockDriver(handler),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

function createApp(mockDb: Kysely<Database>) {
  const app = Fastify();
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    reply.code(500).send({ error: String(err) });
  });
  app.register((instance) => marketplacesRoutes(instance, { db: mockDb }));
  return app;
}

const marketplaceId = "11111111-1111-4111-8111-111111111111";
const webhookId = "22222222-2222-4222-8222-222222222222";

test("DELETE webhook returns 403 when caller does not own marketplace", async () => {
  const mockDb = createMockDb(async (q) => {
    if (q.sql.includes('from "marketplace"')) {
      return { rows: [{ stellar_account: owner.publicKey() }] };
    }
    return { rows: [] };
  });

  const app = createApp(mockDb);

  const token = issueJwt(nonOwner.publicKey());
  const res = await app.inject({
    method: "DELETE",
    url: `/v1/marketplaces/${marketplaceId}/webhooks/${webhookId}`,
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 403);
  assert.deepEqual(JSON.parse(res.body), { error: "only the marketplace's own account can manage its webhooks" });
});

test("DELETE webhook returns 404 when webhook id is not found", async () => {
  const mockDb = createMockDb(async (q) => {
    if (q.sql.includes('from "marketplace"')) {
      return { rows: [{ stellar_account: owner.publicKey() }] };
    }
    if (q.sql.includes('delete from "webhook_subscription"')) {
      return { rows: [] }; // No row deleted
    }
    return { rows: [] };
  });

  const app = createApp(mockDb);

  const token = issueJwt(owner.publicKey());
  const res = await app.inject({
    method: "DELETE",
    url: `/v1/marketplaces/${marketplaceId}/webhooks/${webhookId}`,
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: "webhook not found" });
});

test("DELETE webhook returns 204 when owner deletes existing subscription", async () => {
  let deletedWhereParams: unknown[] = [];
  const mockDb = createMockDb(async (q) => {
    if (q.sql.includes('from "marketplace"')) {
      return { rows: [{ stellar_account: owner.publicKey() }] };
    }
    if (q.sql.includes('delete from "webhook_subscription"')) {
      deletedWhereParams = [...q.parameters];
      return { rows: [{ id: webhookId }] };
    }
    return { rows: [] };
  });

  const app = createApp(mockDb);

  const token = issueJwt(owner.publicKey());
  const res = await app.inject({
    method: "DELETE",
    url: `/v1/marketplaces/${marketplaceId}/webhooks/${webhookId}`,
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 204);
  assert.equal(res.body, "");
  assert.ok(deletedWhereParams.includes(webhookId));
  assert.ok(deletedWhereParams.includes(marketplaceId));
});

test("deleting one of 10 webhooks frees a slot and allows new registration", async () => {
  let webhookCount = 10;
  const mockDb = createMockDb(async (q) => {
    if (q.sql.includes('from "marketplace"')) {
      return { rows: [{ stellar_account: owner.publicKey() }] };
    }
    if (q.sql.includes('delete from "webhook_subscription"')) {
      webhookCount = 9;
      return { rows: [{ id: webhookId }] };
    }
    if (q.sql.includes('count(*) as "count"')) {
      return { rows: [{ count: webhookCount }] };
    }
    if (q.sql.includes('insert into "webhook_subscription"')) {
      return {
        rows: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            marketplace_id: marketplaceId,
            url: "https://example.com/hook",
            events: ["submission.verified"],
            active: true,
            created_at: new Date().toISOString(),
          },
        ],
      };
    }
    return { rows: [] };
  });

  const app = createApp(mockDb);

  const token = issueJwt(owner.publicKey());

  // At count 10, registering fails with 409
  const res409 = await app.inject({
    method: "POST",
    url: `/v1/marketplaces/${marketplaceId}/webhooks`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      url: "https://example.com/hook",
      secret: "secret-key-1234",
      events: ["submission.verified"],
    },
  });
  assert.equal(res409.statusCode, 409);
  assert.match(JSON.parse(res409.body).error, /delete an existing subscription to free a slot/);

  // Delete one subscription
  const deleteRes = await app.inject({
    method: "DELETE",
    url: `/v1/marketplaces/${marketplaceId}/webhooks/${webhookId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(deleteRes.statusCode, 204);

  // Now count is 9, registering succeeds with 201
  const res201 = await app.inject({
    method: "POST",
    url: `/v1/marketplaces/${marketplaceId}/webhooks`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      url: "https://example.com/hook",
      secret: "secret-key-1234",
      events: ["submission.verified"],
    },
  });
  assert.equal(res201.statusCode, 201);
});

const validBase = {
  url: "https://example.org/verity-webhook",
  secret: "super-secret-token",
};

test("WEBHOOK_EVENTS includes submission.expired_unverified alongside the other events", () => {
  assert.deepEqual([...WEBHOOK_EVENTS], [
    "submission.verified",
    "submission.slashed",
    "submission.expired_unverified",
    "submission.disputed",
  ]);
});

test("createWebhookBody accepts submission.expired_unverified alone or with other events", () => {
  const single = createWebhookBody.parse({
    ...validBase,
    events: ["submission.expired_unverified"],
  });
  assert.deepEqual(single.events, ["submission.expired_unverified"]);

  const all = createWebhookBody.parse({
    ...validBase,
    events: [
      "submission.verified",
      "submission.slashed",
      "submission.expired_unverified",
      "submission.disputed",
    ],
  });
  assert.equal(all.events.length, 4);
});

test("createWebhookBody rejects unknown event names and empty event lists", () => {
  assert.throws(() =>
    createWebhookBody.parse({ ...validBase, events: ["submission.pending"] })
  );
  assert.throws(() =>
    createWebhookBody.parse({ ...validBase, events: ["submission.unknown"] })
  );
  assert.throws(() => createWebhookBody.parse({ ...validBase, events: [] }));
});
