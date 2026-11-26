import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Keypair, Networks, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { ApiError, createWorker, type Assignment, type EscrowGateLike, type SubmissionLike } from "./index.js";
import { REPLAY_ENGINE } from "./sandbox/runner.js";

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

const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distIndex = join(agentRoot, "dist", "index.js");
const distRunner = join(agentRoot, "dist", "sandbox", "runner.js");
const distWorker = join(agentRoot, "dist", "sandbox", "replay-worker.mjs");
const CONTRACT_ID = "CDUMMY000000000000000000000000000000000000000000000000000000";

function buildOnce() {
  if (existsSync(distIndex) && existsSync(distRunner) && existsSync(distWorker)) return;
  const tscBin = join(agentRoot, "node_modules", "typescript", "bin", "tsc");
  const res = spawnSync(process.execPath, [tscBin, "-p", join(agentRoot, "tsconfig.json")], {
    cwd: agentRoot,
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `tsc failed: ${res.stderr || res.stdout}`);
  writeFileSync(distWorker, readFileSync(join(agentRoot, "src", "sandbox", "replay-worker.mjs")));
}

function runCompiledIndex(env: Record<string, string | undefined>, args: string[] = []) {
  buildOnce();
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    ESCROW_GATE_CONTRACT_ID: CONTRACT_ID,
    ...env,
  };
  for (const [k, v] of Object.entries(childEnv)) {
    if (v === undefined) delete childEnv[k];
  }
  return spawnSync(process.execPath, [distIndex, ...args], {
    cwd: tmpdir(),
    env: childEnv,
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("compiled dist/ runner keeps REPLAY_ENGINE and worked-example hash identical", { timeout: 20_000 }, async () => {
  buildOnce();
  assert.equal(existsSync(distWorker), true, "replay-worker.mjs must sit next to dist/sandbox/runner.js");
  const pkg = JSON.parse(readFileSync(join(agentRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const enginePrefix = `quickjs-emscripten@${pkg.dependencies["quickjs-emscripten"]} (wasm sandbox, worker-isolated`;
  assert.ok(REPLAY_ENGINE.startsWith(enginePrefix), `REPLAY_ENGINE should name the pinned engine: ${REPLAY_ENGINE}`);

  const compiled = (await import(pathToFileURL(distRunner).href)) as typeof import("./sandbox/runner.js");
  assert.equal(compiled.REPLAY_ENGINE, REPLAY_ENGINE);
  const result = await compiled.runDeterministicFunction("return { doubled: input.n * 2 };", { n: 21 });
  assert.deepEqual(result.output, { doubled: 42 });
  assert.equal(result.outputHash, "27d4958085af3032ba46babb9e0b71690f9e2cc745ff7bb403a3d54e12152f82");
  assert.equal(result.engine, REPLAY_ENGINE);
});

test("fails at startup when neither REEXECUTOR_SECRET_KEY nor REEXECUTOR_SECRET_KEY_FILE is set", () => {
  const res = runCompiledIndex({
    REEXECUTOR_SECRET_KEY: undefined,
    REEXECUTOR_SECRET_KEY_FILE: undefined,
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /REEXECUTOR_SECRET_KEY or REEXECUTOR_SECRET_KEY_FILE is required/);
});

test("fails at startup when both REEXECUTOR_SECRET_KEY and REEXECUTOR_SECRET_KEY_FILE are set", () => {
  const dir = mkdtempSync(join(tmpdir(), "verity-rex-secret-"));
  try {
    const secretFile = join(dir, "rex.secret");
    writeFileSync(secretFile, `${Keypair.random().secret()}\n`, "utf8");
    const res = runCompiledIndex({
      REEXECUTOR_SECRET_KEY: Keypair.random().secret(),
      REEXECUTOR_SECRET_KEY_FILE: secretFile,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /set either REEXECUTOR_SECRET_KEY or REEXECUTOR_SECRET_KEY_FILE, not both/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails at startup when REEXECUTOR_SECRET_KEY_FILE is missing or empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "verity-rex-secret-"));
  try {
    const missing = runCompiledIndex({
      REEXECUTOR_SECRET_KEY: undefined,
      REEXECUTOR_SECRET_KEY_FILE: join(dir, "does-not-exist"),
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /failed to read REEXECUTOR_SECRET_KEY_FILE/);

    const emptyFile = join(dir, "empty.secret");
    writeFileSync(emptyFile, "  \n\t\n", "utf8");
    const empty = runCompiledIndex({
      REEXECUTOR_SECRET_KEY: undefined,
      REEXECUTOR_SECRET_KEY_FILE: emptyFile,
    });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /REEXECUTOR_SECRET_KEY_FILE .* is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads and trims REEXECUTOR_SECRET_KEY_FILE and logs in, syncs and polls", { timeout: 20_000 }, async () => {
  buildOnce();
  const rex = Keypair.random();
  const serverKey = Keypair.random();
  const dir = mkdtempSync(join(tmpdir(), "verity-rex-secret-"));
  const secretFile = join(dir, "rex.secret");
  writeFileSync(secretFile, `  ${rex.secret()}\r\n`, "utf8");

  let synced = false;
  let polled = false;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // The worker discovers and pins this server before it signs anything (SEP-10),
    // so the stub publishes its signing key and issues spec-conformant challenges.
    const host = req.headers.host ?? "127.0.0.1";
    if (req.method === "GET" && url.pathname === "/.well-known/stellar.toml") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`SIGNING_KEY="${serverKey.publicKey()}"\nWEB_AUTH_ENDPOINT="http://${host}/auth"\n`);
      return;
    }
    if (req.method === "GET" && url.pathname === "/auth") {
      assert.equal(url.searchParams.get("account"), rex.publicKey());
      const transaction = WebAuth.buildChallengeTx(serverKey, rex.publicKey(), host, 300, Networks.TESTNET, host);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ transaction }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/auth") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { transaction: string };
      const tx = TransactionBuilder.fromXDR(body.transaction, Networks.TESTNET);
      assert.equal(
        tx.signatures.some((sig) => {
          const raw =
            typeof sig.signature === "function"
              ? (sig.signature as unknown as () => Buffer)()
              : (sig.signature as unknown as Buffer);
          return rex.verify(tx.hash(), raw);
        }),
        true,
        "challenge must be signed by the key loaded from REEXECUTOR_SECRET_KEY_FILE"
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "test-jwt-token" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/reexecutors/sync") {
      assert.equal(req.headers.authorization, "Bearer test-jwt-token");
      synced = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          reexecutor: { id: "rex-1", active: true, approved: true, stake_amount: "5000000000" },
        })
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/reexecutors/rex-1/assignments") {
      assert.equal(req.headers.authorization, "Bearer test-jwt-token");
      polled = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ replay_assignments: [], spot_check_assignments: [] }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const child = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChild, rejectChild) => {
      const proc = spawn(process.execPath, [distIndex, "--once"], {
        cwd: tmpdir(),
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          BACKEND_URL: `http://127.0.0.1:${address.port}`,
          ESCROW_GATE_CONTRACT_ID: CONTRACT_ID,
          REEXECUTOR_SECRET_KEY: "",
          REEXECUTOR_SECRET_KEY_FILE: `  ${secretFile}  `,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      proc.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      proc.on("error", rejectChild);
      proc.on("close", (code) => resolveChild({ code, stdout, stderr }));
    });
    assert.equal(child.code, 0, `expected exit 0, got ${child.code}: ${child.stderr}`);
    assert.equal(synced, true);
    assert.equal(polled, true);
    assert.match(child.stdout, new RegExp(`\\[reexecutor-agent\\] starting as ${rex.publicKey()}`));
    assert.ok(child.stdout.includes(`[reexecutor-agent] replay engine: ${REPLAY_ENGINE}`));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
