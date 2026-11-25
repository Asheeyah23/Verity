import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { CompiledQuery, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, QueryResult } from "kysely";
import type { Database } from "@verity/db";
import { HttpError } from "../../http-error.js";
import { ZodError } from "zod";

const keeper = Keypair.random();
const server = Keypair.random();
const owner = Keypair.random();
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

const { marketplacesRoutes } = await import("./routes.js");
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

test("POST webhook locks marketplace row with forUpdate inside transaction before checking count", async () => {
  const queriesExecuted: string[] = [];
  const mockDb = createMockDb(async (q) => {
    queriesExecuted.push(q.sql);
    if (q.sql.includes('from "marketplace"') && !q.sql.includes("for update")) {
      return { rows: [{ stellar_account: owner.publicKey() }] };
    }
    if (q.sql.includes('from "marketplace"') && q.sql.includes("for update")) {
      return { rows: [{ id: marketplaceId }] };
    }
    if (q.sql.includes('count(*) as "count"')) {
      return { rows: [{ count: 0 }] };
    }
    if (q.sql.includes('insert into "webhook_subscription"')) {
      return {
        rows: [
          {
            id: "22222222-2222-4222-8222-222222222222",
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

  const res = await app.inject({
    method: "POST",
    url: `/v1/marketplaces/${marketplaceId}/webhooks`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      url: "https://example.com/hook",
      secret: "secret-key-1234",
      events: ["submission.verified"],
    },
  });

  assert.equal(res.statusCode, 201);
  // Verify that the row lock query was executed
  const lockQueryIndex = queriesExecuted.findIndex(
    (sql) => sql.includes('from "marketplace"') && sql.toLowerCase().includes("for update")
  );
  const countQueryIndex = queriesExecuted.findIndex((sql) => sql.includes('count(*) as "count"'));
  const insertQueryIndex = queriesExecuted.findIndex((sql) => sql.includes('insert into "webhook_subscription"'));

  assert.ok(lockQueryIndex >= 0, "Expected SELECT ... FOR UPDATE query on marketplace table");
  assert.ok(countQueryIndex > lockQueryIndex, "Count must happen after acquiring the row lock");
  assert.ok(insertQueryIndex > countQueryIndex, "Insert must happen after checking count under lock");
});

test("POST webhook rejects with 409 and does not insert when count >= 10", async () => {
  let insertExecuted = false;
  const mockDb = createMockDb(async (q) => {
    if (q.sql.includes('from "marketplace"') && !q.sql.includes("for update")) {
      return { rows: [{ stellar_account: owner.publicKey() }] };
    }
    if (q.sql.includes('from "marketplace"') && q.sql.includes("for update")) {
      return { rows: [{ id: marketplaceId }] };
    }
    if (q.sql.includes('count(*) as "count"')) {
      return { rows: [{ count: 10 }] };
    }
    if (q.sql.includes('insert into "webhook_subscription"')) {
      insertExecuted = true;
      return { rows: [] };
    }
    return { rows: [] };
  });

  const app = createApp(mockDb);
  const token = issueJwt(owner.publicKey());

  const res = await app.inject({
    method: "POST",
    url: `/v1/marketplaces/${marketplaceId}/webhooks`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      url: "https://example.com/hook",
      secret: "secret-key-1234",
      events: ["submission.verified"],
    },
  });

  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /at most 10 webhook subscriptions/);
  assert.equal(insertExecuted, false, "Insert must not be executed when cap is reached");
});

test("POST webhook enforces cap under sequential simulated transactions", async () => {
  let currentCount = 8;
  const mockDb = createMockDb(async (q) => {
    if (q.sql.includes('from "marketplace"') && !q.sql.includes("for update")) {
      return { rows: [{ stellar_account: owner.publicKey() }] };
    }
    if (q.sql.includes('from "marketplace"') && q.sql.includes("for update")) {
      return { rows: [{ id: marketplaceId }] };
    }
    if (q.sql.includes('count(*) as "count"')) {
      return { rows: [{ count: currentCount }] };
    }
    if (q.sql.includes('insert into "webhook_subscription"')) {
      currentCount++;
      return {
        rows: [
          {
            id: crypto.randomUUID(),
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

  const results: number[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/marketplaces/${marketplaceId}/webhooks`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        url: "https://example.com/hook",
        secret: "secret-key-1234",
        events: ["submission.verified"],
      },
    });
    results.push(res.statusCode);
  }

  // Count starts at 8: first 2 succeed (201), remaining 2 fail (409)
  assert.deepEqual(results, [201, 201, 409, 409]);
  assert.equal(currentCount, 10);
});
