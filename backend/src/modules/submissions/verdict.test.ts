import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import type { Database, SubmissionResolutionMethod, SubmissionStatus } from "@verity/db";
import type { WebhookSubscriptionRecord } from "../webhooks/dispatcher.js";

// verdict.ts imports db.ts and chain/actions.ts -> env.ts at module load time.
// Set every required field before its first dynamic import so a developer's
// backend/.env is never used.
Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org", // never contacted
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ESCROW_GATE_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { recordTerminalVerdict, buildVerdictWebhookPayload } = await import("./verdict.js");
const { dispatchWebhook } = await import("../webhooks/dispatcher.js");

interface FakeSubmissionRow {
  id: string;
  marketplace_id: string;
  status: SubmissionStatus;
  chain_submission_id: string | null;
  escrow_ref: string;
  resolution_method: SubmissionResolutionMethod | null;
  finalize_tx_hash: string | null;
  updated_at: Date;
}

interface FakeChallengeRow {
  id: string;
  submission_id: string;
  resolved_at: Date | null;
}

interface RecordedDelivery {
  subscriptionId: string;
  eventType: string;
  payload: unknown;
}

function createHarness(initial: {
  submissions: FakeSubmissionRow[];
  subscriptions: WebhookSubscriptionRecord[];
  challenges?: FakeChallengeRow[];
  chainResolutionMethod?: { tag: string };
}) {
  const submissions = initial.submissions.map((s) => ({ ...s }));
  const subscriptions = initial.subscriptions.map((s) => ({ ...s, events: [...s.events] }));
  const challenges = (initial.challenges ?? []).map((c) => ({ ...c }));
  const deliveries: RecordedDelivery[] = [];

  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const { sql, parameters } = compiled;

      if (
        sql.startsWith(
          'update "submission" set "status" = $1, "resolution_method" = $2, "finalize_tx_hash" = $3, "updated_at" = $4 where "id" = $5 and "status" != $6'
        )
      ) {
        const [newStatus, resolutionMethod, finalizeTxHash, updatedAt, id, notStatus] = parameters as [
          SubmissionStatus,
          SubmissionResolutionMethod | null,
          string | null,
          Date,
          string,
          SubmissionStatus,
        ];
        const row = submissions.find((s) => s.id === id && s.status !== notStatus);
        if (!row) return { rows: [] };
        row.status = newStatus;
        row.resolution_method = resolutionMethod;
        row.finalize_tx_hash = finalizeTxHash;
        row.updated_at = updatedAt;
        return { rows: [{ ...row } as unknown as R] };
      }

      if (sql.startsWith('select * from "submission" where "id" = $1')) {
        const [id] = parameters as [string];
        const row = submissions.find((s) => s.id === id);
        return { rows: row ? [{ ...row } as unknown as R] : [] };
      }

      if (sql.startsWith('update "submission" set "resolution_method" = $1, "finalize_tx_hash" = $2 where "id" = $3')) {
        const [resolutionMethod, finalizeTxHash, id] = parameters as [
          SubmissionResolutionMethod | null,
          string | null,
          string,
        ];
        const row = submissions.find((s) => s.id === id);
        if (row) {
          row.resolution_method = resolutionMethod;
          row.finalize_tx_hash = finalizeTxHash;
        }
        return { rows: [] };
      }

      if (sql.startsWith('update "challenge" set "resolved_at" = $1 where "submission_id" = $2 and "resolved_at" is null')) {
        const [resolvedAt, submissionId] = parameters as [Date, string];
        for (const ch of challenges) {
          if (ch.submission_id === submissionId && ch.resolved_at === null) {
            ch.resolved_at = resolvedAt;
          }
        }
        return { rows: [] };
      }

      if (sql.startsWith('select * from "webhook_subscription" where "marketplace_id" = $1 and "active" = $2')) {
        const [marketplaceId, active] = parameters as [string, boolean];
        const rows = subscriptions
          .filter((s) => s.marketplace_id === marketplaceId && s.active === active)
          .map((s) => ({ ...s, events: [...s.events] }) as unknown as R);
        return { rows };
      }

      throw new Error(`Unexpected SQL in verdict test harness: ${sql}`);
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error("streamQuery not implemented in verdict test harness");
    },
  };

  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };

  const fakeDb = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (dbInstance) => new PostgresIntrospector(dbInstance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  const readSubmission = async () =>
    ({ resolution_method: initial.chainResolutionMethod ?? { tag: "WindowElapsed" } }) as any;

  const dispatch = async (marketplaceId: string, eventType: string, payload: unknown) => {
    await dispatchWebhook(marketplaceId, eventType, payload, {
      db: fakeDb,
      deliver: async (sub, ev, body) => {
        deliveries.push({ subscriptionId: sub.id, eventType: ev, payload: body });
      },
    });
  };

  return {
    submissions,
    challenges,
    deliveries,
    deps: { db: fakeDb, readSubmission, dispatchWebhook: dispatch },
  };
}

const MARKETPLACE_A = "11111111-1111-4111-8111-111111111111";
const MARKETPLACE_B = "22222222-2222-4222-8222-222222222222";
const SUBMISSION_ID = "33333333-3333-4333-8333-333333333333";

function makeSub(overrides: Partial<FakeSubmissionRow> = {}): FakeSubmissionRow {
  return {
    id: SUBMISSION_ID,
    marketplace_id: MARKETPLACE_A,
    status: "pending",
    chain_submission_id: "42",
    escrow_ref: "escrow-ref-1",
    resolution_method: null,
    finalize_tx_hash: null,
    updated_at: new Date("2026-10-25T00:00:00.000Z"),
    ...overrides,
  };
}

function makeWebhook(overrides: Partial<WebhookSubscriptionRecord> & { id: string }): WebhookSubscriptionRecord {
  return {
    marketplace_id: MARKETPLACE_A,
    url: "https://example.org/hook",
    secret: "super-secret-token",
    events: ["submission.expired_unverified"],
    active: true,
    ...overrides,
  };
}

test("transitioning to expired_unverified delivers once to subscribed hooks and never to others", async () => {
  const harness = createHarness({
    submissions: [makeSub()],
    subscriptions: [
      makeWebhook({ id: "sub-expired-only", events: ["submission.expired_unverified"] }),
      makeWebhook({ id: "sub-all-verdicts", events: ["submission.verified", "submission.slashed", "submission.expired_unverified"] }),
      makeWebhook({ id: "sub-verified-slashed-only", events: ["submission.verified", "submission.slashed", "submission.disputed"] }),
      makeWebhook({ id: "sub-inactive", events: ["submission.expired_unverified"], active: false }),
      makeWebhook({ id: "sub-other-marketplace", marketplace_id: MARKETPLACE_B, events: ["submission.expired_unverified"] }),
    ],
  });

  const txHash = "a".repeat(64);
  await recordTerminalVerdict(SUBMISSION_ID, "expired_unverified", txHash, undefined, harness.deps);
  // Allow background Promise.allSettled in dispatchWebhook to settle.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.deliveries, [
    {
      subscriptionId: "sub-expired-only",
      eventType: "submission.expired_unverified",
      payload: {
        submission_id: SUBMISSION_ID,
        chain_submission_id: "42",
        escrow_ref: "escrow-ref-1",
        status: "expired_unverified",
        resolution_method: "window_elapsed",
        tx_hash: txHash,
      },
    },
    {
      subscriptionId: "sub-all-verdicts",
      eventType: "submission.expired_unverified",
      payload: {
        submission_id: SUBMISSION_ID,
        chain_submission_id: "42",
        escrow_ref: "escrow-ref-1",
        status: "expired_unverified",
        resolution_method: "window_elapsed",
        tx_hash: txHash,
      },
    },
  ]);

  // Repeating recordTerminalVerdict once already terminal must not fire again.
  await recordTerminalVerdict(SUBMISSION_ID, "expired_unverified", txHash, undefined, harness.deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.deliveries.length, 2);
});

test("expired_unverified without txHash sends tx_hash: null, fills resolution_method, and closes open challenges", async () => {
  const harness = createHarness({
    submissions: [makeSub({ status: "disputed" })],
    subscriptions: [makeWebhook({ id: "sub-expired", events: ["submission.expired_unverified"] })],
    challenges: [{ id: "ch-1", submission_id: SUBMISSION_ID, resolved_at: null }],
    chainResolutionMethod: { tag: "WindowElapsed" },
  });

  await recordTerminalVerdict(SUBMISSION_ID, "expired_unverified", undefined, undefined, harness.deps);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.deliveries, [
    {
      subscriptionId: "sub-expired",
      eventType: "submission.expired_unverified",
      payload: {
        submission_id: SUBMISSION_ID,
        chain_submission_id: "42",
        escrow_ref: "escrow-ref-1",
        status: "expired_unverified",
        resolution_method: "window_elapsed",
        tx_hash: null,
      },
    },
  ]);
  assert.equal(harness.submissions[0]!.resolution_method, "window_elapsed");
  assert.equal(harness.submissions[0]!.finalize_tx_hash, null);
  assert.ok(harness.challenges[0]!.resolved_at instanceof Date);
});

test("verified and slashed continue to dispatch with the same payload shape", async () => {
  for (const terminal of ["verified", "slashed"] as const) {
    const harness = createHarness({
      submissions: [makeSub()],
      subscriptions: [
        makeWebhook({ id: `sub-${terminal}`, events: [`submission.${terminal}`] }),
        makeWebhook({ id: "sub-expired-only", events: ["submission.expired_unverified"] }),
      ],
      chainResolutionMethod: { tag: "ReexecutionConsensus" },
    });

    const txHash = "b".repeat(64);
    await recordTerminalVerdict(SUBMISSION_ID, terminal, txHash, undefined, harness.deps);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(harness.deliveries, [
      {
        subscriptionId: `sub-${terminal}`,
        eventType: `submission.${terminal}`,
        payload: {
          submission_id: SUBMISSION_ID,
          chain_submission_id: "42",
          escrow_ref: "escrow-ref-1",
          status: terminal,
          resolution_method: "reexecution_consensus",
          tx_hash: txHash,
        },
      },
    ]);
  }
});

test("non-terminal statuses are ignored and dispatch no webhook", async () => {
  const harness = createHarness({
    submissions: [makeSub()],
    subscriptions: [
      makeWebhook({
        id: "sub-all",
        events: [
          "submission.verified",
          "submission.slashed",
          "submission.expired_unverified",
          "submission.disputed",
        ],
      }),
    ],
  });

  await recordTerminalVerdict(SUBMISSION_ID, "pending", null, undefined, harness.deps);
  await recordTerminalVerdict(SUBMISSION_ID, "disputed", null, undefined, harness.deps);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.deliveries.length, 0);
  assert.equal(harness.submissions[0]!.status, "pending");
});

test("buildVerdictWebhookPayload creates complete payload for verified consensus verdict", () => {
  const sub = {
    id: "11111111-1111-4111-8111-111111111111",
    chain_submission_id: "42",
    escrow_ref: "escrow-order-123",
    resolution_method: "reexecution_consensus" as const,
  };

  const payload = buildVerdictWebhookPayload(sub, "verified", "0xabc123");

  assert.deepEqual(payload, {
    submission_id: "11111111-1111-4111-8111-111111111111",
    chain_submission_id: "42",
    escrow_ref: "escrow-order-123",
    status: "verified",
    resolution_method: "reexecution_consensus",
    tx_hash: "0xabc123",
  });
});

test("buildVerdictWebhookPayload creates complete payload for slashed verdict with null tx_hash", () => {
  const sub = {
    id: "22222222-2222-4222-8222-222222222222",
    chain_submission_id: "99",
    escrow_ref: "escrow-order-456",
    resolution_method: "window_elapsed" as const,
  };

  const payload = buildVerdictWebhookPayload(sub, "slashed", null);

  assert.deepEqual(payload, {
    submission_id: "22222222-2222-4222-8222-222222222222",
    chain_submission_id: "99",
    escrow_ref: "escrow-order-456",
    status: "slashed",
    resolution_method: "window_elapsed",
    tx_hash: null,
  });
});

test("buildVerdictWebhookPayload handles optional fields when null or undefined", () => {
  const sub = {
    id: "33333333-3333-4333-8333-333333333333",
    chain_submission_id: null,
    escrow_ref: "escrow-order-789",
    resolution_method: null,
  };

  const payload = buildVerdictWebhookPayload(sub, "verified", undefined);

  assert.deepEqual(payload, {
    submission_id: "33333333-3333-4333-8333-333333333333",
    chain_submission_id: null,
    escrow_ref: "escrow-order-789",
    status: "verified",
    resolution_method: null,
    tx_hash: null,
  });
});
