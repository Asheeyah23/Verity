import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, createWorker, type Assignment, type EscrowGateLike, type SubmissionLike } from "./index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(done: () => boolean, what: string, capMs = 3000) {
  const deadline = Date.now() + capMs;
  while (!done()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const HASH_A = "a".repeat(64);

function makeSubmission(overrides: Partial<SubmissionLike> = {}): SubmissionLike {
  return {
    finalized: false,
    task_type: { tag: "Deterministic", values: undefined },
    claimed_output_hash: Buffer.from(HASH_A, "hex"),
    input_hash: Buffer.from(HASH_A, "hex"),
    challenge_window_s: 300n,
    submitted_at: 1000n,
    ...overrides,
  };
}

function makeAssignment(id: string): Assignment {
  return {
    chain_submission_id: id,
    function_ref: `fn-${id}`,
    input_ref: `in-${id}`,
  };
}

test("when assignments returns 403 for the old id, the worker calls sync once, switches to the new id, and the next poll succeeds", async () => {
  let syncCalls = 0;
  const assignmentCalls: string[] = [];
  const attestedSubmissions: bigint[] = [];

  const client: EscrowGateLike = {
    get_submission: async () => ({ result: makeSubmission() }),
    attest_replay: async ({ submission_id }) => ({
      signAndSend: async () => {
        attestedSubmissions.push(submission_id);
        return { result: { unwrap: () => {} }, sendTransactionResponse: { hash: "tx-1" } };
      },
    }),
  };

  const worker = createWorker({
    publicKey: PUBLIC_KEY,
    initialReexecutorId: "old-id",
    client,
    reExecute: async () => ({ outputHash: HASH_A, engine: "fake" }),
    api: async <T>(path: string, init?: { method?: string }): Promise<T> => {
      if (path === "/v1/reexecutors/sync" && init?.method === "POST") {
        syncCalls++;
        return {
          reexecutor: { id: "new-id", active: true, approved: true, stake_amount: "100000000" },
        } as T;
      }
      if (path === "/v1/reexecutors/old-id/assignments") {
        assignmentCalls.push("old-id");
        throw new ApiError(403, "GET /v1/reexecutors/old-id/assignments -> 403: forbidden");
      }
      if (path === "/v1/reexecutors/new-id/assignments") {
        assignmentCalls.push("new-id");
        return {
          replay_assignments: [makeAssignment("1")],
          spot_check_assignments: [],
        } as T;
      }
      throw new Error(`unexpected API call: ${init?.method ?? "GET"} ${path}`);
    },
  });

  // First poll sees 403 on old-id, calls sync once, and switches to new-id.
  await worker.pollOnce();
  assert.equal(syncCalls, 1);
  assert.equal(worker.reexecutorId, "new-id");
  assert.deepEqual(assignmentCalls, ["old-id"]);
  assert.deepEqual(attestedSubmissions, []);

  // Next poll uses new-id and succeeds.
  await worker.pollOnce();
  assert.equal(syncCalls, 1);
  assert.deepEqual(assignmentCalls, ["old-id", "new-id"]);
  assert.deepEqual(attestedSubmissions, [1n]);
});

test("when heartbeat returns 403 for the old id after initial sync, the worker resyncs once and the next poll succeeds", async () => {
  let syncCalls = 0;
  let activeId = "old-id";
  const heartbeatIds: string[] = [];
  const pollIds: string[] = [];

  const client: EscrowGateLike = {
    get_submission: async () => ({ result: makeSubmission() }),
    attest_replay: async () => ({
      signAndSend: async () => ({ result: { unwrap: () => {} } }),
    }),
  };

  const worker = createWorker({
    publicKey: PUBLIC_KEY,
    client,
    reExecute: async () => ({ outputHash: HASH_A, engine: "fake" }),
    api: async <T>(path: string, init?: { method?: string }): Promise<T> => {
      if (path === "/v1/reexecutors/sync" && init?.method === "POST") {
        syncCalls++;
        return {
          reexecutor: { id: activeId, active: true, approved: true, stake_amount: "100" },
        } as T;
      }
      const hbMatch = /^\/v1\/reexecutors\/([^/]+)\/heartbeat$/.exec(path);
      if (hbMatch && init?.method === "POST") {
        heartbeatIds.push(hbMatch[1]);
        if (hbMatch[1] !== activeId) throw new ApiError(403, `POST ${path} -> 403: forbidden`);
        return {} as T;
      }
      const pollMatch = /^\/v1\/reexecutors\/([^/]+)\/assignments$/.exec(path);
      if (pollMatch) {
        pollIds.push(pollMatch[1]);
        if (pollMatch[1] !== activeId) throw new ApiError(403, `GET ${path} -> 403: forbidden`);
        return { replay_assignments: [], spot_check_assignments: [] } as T;
      }
      throw new Error(`unexpected API call: ${init?.method ?? "GET"} ${path}`);
    },
  });

  // Startup sync learns old-id.
  await worker.sync();
  assert.equal(worker.reexecutorId, "old-id");
  assert.equal(syncCalls, 1);

  // Backend resets and assigns new-id on the next sync.
  activeId = "new-id";
  await worker.beat();
  assert.equal(syncCalls, 2);
  assert.equal(worker.reexecutorId, "new-id");
  assert.deepEqual(heartbeatIds, ["old-id"]);

  // Next poll uses new-id and succeeds without another sync.
  await worker.pollOnce();
  assert.equal(syncCalls, 2);
  assert.deepEqual(pollIds, ["new-id"]);
});

test("403/404 resync is rate-limited to at most once a minute across polls and heartbeats", async () => {
  let currentNow = 10_000;
  let syncCalls = 0;

  const client: EscrowGateLike = {
    get_submission: async () => ({ result: makeSubmission() }),
    attest_replay: async () => ({
      signAndSend: async () => ({ result: { unwrap: () => {} } }),
    }),
  };

  const worker = createWorker({
    publicKey: PUBLIC_KEY,
    initialReexecutorId: "stale-1",
    now: () => currentNow,
    resyncCooldownMs: 60_000,
    client,
    api: async <T>(path: string, init?: { method?: string }): Promise<T> => {
      if (path === "/v1/reexecutors/sync" && init?.method === "POST") {
        syncCalls++;
        return {
          reexecutor: { id: `stale-${syncCalls + 1}`, active: true, approved: true, stake_amount: "100" },
        } as T;
      }
      throw new Error(`${init?.method ?? "GET"} ${path} -> 404: not found`);
    },
  });

  await worker.pollOnce();
  assert.equal(syncCalls, 1);
  assert.equal(worker.reexecutorId, "stale-2");

  // Within the 60s window, neither another failing poll nor a failing heartbeat triggers sync again.
  currentNow += 15_000;
  await worker.beat();
  await worker.pollOnce();
  assert.equal(syncCalls, 1);
  assert.equal(worker.reexecutorId, "stale-2");

  // Once 60s have elapsed, the next 403/404 triggers sync again.
  currentNow += 45_000;
  await worker.beat();
  assert.equal(syncCalls, 2);
  assert.equal(worker.reexecutorId, "stale-3");
});

test("with three assignments where the first vote fails with Error(Contract, #20), no replay runs for the other two in that poll", async () => {
  const replayed: string[] = [];
  let syncCalls = 0;

  const client: EscrowGateLike = {
    get_submission: async ({ id }) => ({ result: makeSubmission({ id } as Partial<SubmissionLike>) }),
    attest_replay: async () => {
      throw new Error("HostError: Error(Contract, #20)");
    },
  };

  const worker = createWorker({
    publicKey: PUBLIC_KEY,
    initialReexecutorId: "reexec-1",
    client,
    reExecute: async (a) => {
      replayed.push(a.chain_submission_id);
      return { outputHash: HASH_A, engine: "fake" };
    },
    api: async <T>(path: string, init?: { method?: string }): Promise<T> => {
      if (path === "/v1/reexecutors/reexec-1/assignments") {
        return {
          replay_assignments: [makeAssignment("1"), makeAssignment("2"), makeAssignment("3")],
          spot_check_assignments: [],
        } as T;
      }
      if (path === "/v1/reexecutors/sync" && init?.method === "POST") {
        syncCalls++;
        return {
          reexecutor: { id: "reexec-1", active: false, approved: true, stake_amount: "0" },
        } as T;
      }
      throw new Error(`unexpected API call: ${init?.method ?? "GET"} ${path}`);
    },
  });

  await worker.pollOnce();

  assert.deepEqual(replayed, ["1"]);
  assert.equal(syncCalls, 1);
  assert.ok(worker.votingBlockedUntil > Date.now());
});

test("Error(Contract, #27) also stops the current poll loop and syncs", async () => {
  const replayed: string[] = [];
  let syncCalls = 0;

  const client: EscrowGateLike = {
    get_submission: async () => ({ result: makeSubmission() }),
    attest_replay: async () => {
      throw new Error("HostError: Error(Contract, #27)");
    },
  };

  const worker = createWorker({
    publicKey: PUBLIC_KEY,
    initialReexecutorId: "reexec-1",
    client,
    reExecute: async (a) => {
      replayed.push(a.chain_submission_id);
      return { outputHash: HASH_A, engine: "fake" };
    },
    api: async <T>(path: string, init?: { method?: string }): Promise<T> => {
      if (path === "/v1/reexecutors/reexec-1/assignments") {
        return {
          replay_assignments: [makeAssignment("10")],
          spot_check_assignments: [makeAssignment("11")],
        } as T;
      }
      if (path === "/v1/reexecutors/sync" && init?.method === "POST") {
        syncCalls++;
        return {
          reexecutor: { id: "reexec-1", active: true, approved: false, stake_amount: "100" },
        } as T;
      }
      throw new Error(`unexpected API call: ${init?.method ?? "GET"} ${path}`);
    },
  });

  await worker.pollOnce();

  assert.deepEqual(replayed, ["10"]);
  assert.equal(syncCalls, 1);
});

test("while blocked, no heartbeat is sent and polls skip liveness; heartbeat resumes after the block expires", async () => {
  let heartbeats = 0;
  let assignmentPolls = 0;
  let refuseVote = true;

  const client: EscrowGateLike = {
    get_submission: async () => ({ result: makeSubmission() }),
    attest_replay: async () => {
      if (refuseVote) throw new Error("Error(Contract, #20)");
      return {
        signAndSend: async () => ({ result: { unwrap: () => {} } }),
      };
    },
  };

  const worker = createWorker({
    publicKey: PUBLIC_KEY,
    initialReexecutorId: "reexec-1",
    heartbeatIntervalMs: 10,
    votingBlockMs: 80,
    client,
    reExecute: async () => ({ outputHash: HASH_A, engine: "fake" }),
    api: async <T>(path: string, init?: { method?: string }): Promise<T> => {
      if (path === "/v1/reexecutors/reexec-1/heartbeat" && init?.method === "POST") {
        heartbeats++;
        return {} as T;
      }
      if (path === "/v1/reexecutors/reexec-1/assignments") {
        assignmentPolls++;
        return {
          replay_assignments: [makeAssignment("1")],
          spot_check_assignments: [],
        } as T;
      }
      if (path === "/v1/reexecutors/sync" && init?.method === "POST") {
        return {
          reexecutor: { id: "reexec-1", active: false, approved: true, stake_amount: "0" },
        } as T;
      }
      throw new Error(`unexpected API call: ${init?.method ?? "GET"} ${path}`);
    },
  });

  try {
    worker.startHeartbeat();
    await waitFor(() => heartbeats >= 2, "initial heartbeats before block");

    // Trigger #20 block via pollOnce.
    await worker.pollOnce();
    assert.equal(assignmentPolls, 1);
    const beatsAtBlock = heartbeats;

    // While blocked, neither heartbeats nor assignment polls hit the backend.
    await sleep(40);
    await worker.pollOnce();
    assert.equal(heartbeats, beatsAtBlock);
    assert.equal(assignmentPolls, 1);

    // After the block expires (80ms), the heartbeat automatically resumes.
    await waitFor(() => heartbeats >= beatsAtBlock + 2, "heartbeats to resume after block expires");

    // And polling resumes once unblocked.
    refuseVote = false;
    await worker.pollOnce();
    assert.equal(assignmentPolls, 2);
  } finally {
    worker.stop();
  }
});
