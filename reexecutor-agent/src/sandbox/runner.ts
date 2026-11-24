import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { canonicalHash } from "./canonical.js";
import { FUEL_GLOBAL_EXPORT, loadInstrumentedQuickJSWasm } from "./wasm-fuel.js";

/**
 * Limits every replay runs under. All three are enforced inside the engine, by
 * the same fuel-instrumented WebAssembly build on every re-executor, so a
 * function that exceeds one — in JS bytecode, native builtins, or bulk memory
 * operations — fails identically everywhere and that failure is a valid
 * (mismatch) result. They are deliberately small: Phase 1 covers pure data
 * transforms, not heavy compute.
 */
export const LIMITS = {
  memoryBytes: 64 * 1024 * 1024,
  // Well under the depth at which the host's own stack would give out first.
  stackBytes: 128 * 1024,
  // Deterministic WebAssembly fuel budget: 1 unit per WASM function entry and
  // loop back-edge, plus 1 unit per 16 bytes for memory.copy/memory.fill.
  // Worst-case workloads exhaust this in ~0.3-2.2s on typical hosts, leaving
  // wide headroom inside WALL_CLOCK_MS even on slow machines.
  fuel: 25_000_000,
} as const;
const MAX_OUTPUT_BYTES = 1_000_000;
/** Not an engine limit: a safety-net kill switch for a genuinely broken or
 * stalled host. Hitting it says nothing about the submission, so it becomes a
 * ReplayInfrastructureError and is retried rather than voted on. */
const WALL_CLOCK_MS = 20_000;

const ENGINE_VERSION: string = createRequire(import.meta.url)("quickjs-emscripten/package.json").version;
const { wasmBinary: INSTRUMENTED_WASM_BINARY, sha256: INSTRUMENTED_WASM_SHA256 } =
  loadInstrumentedQuickJSWasm();
export const REPLAY_ENGINE =
  `quickjs-emscripten@${ENGINE_VERSION} (wasm sandbox, worker-isolated, fuel=${LIMITS.fuel}, wasm=sha256:${INSTRUMENTED_WASM_SHA256})`;

/** The replay could not be carried out on this host. It says nothing about
 * the submission, so it must never become a vote: the caller retries later. */
export class ReplayInfrastructureError extends Error {}

type WorkerResult =
  | { kind: "ok"; outputJson: string | null }
  | { kind: "guest-error"; reason: string }
  | { kind: "host-error"; reason: string };

function runInWorker(functionSource: string, inputJson: string): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./replay-worker.mjs", import.meta.url), {
      workerData: {
        functionSource,
        inputJson,
        limits: LIMITS,
        wasmBinary: INSTRUMENTED_WASM_BINARY,
        fuelGlobalExport: FUEL_GLOBAL_EXPORT,
      },
      // No environment and no loader flags: the worker cannot read this
      // process's secrets from process.env, and loads nothing but the engine.
      env: {},
      execArgv: [],
      // Room for the engine's own stack check to trip before the host's does.
      resourceLimits: { stackSizeMb: 32, maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (result: WorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ kind: "host-error", reason: `no result within ${WALL_CLOCK_MS / 1000}s on this host` }),
      WALL_CLOCK_MS
    );
    worker.once("message", (message: WorkerResult) => finish(message));
    worker.once("error", (err) => finish({ kind: "host-error", reason: err.message }));
    worker.once("exit", (code) => finish({ kind: "host-error", reason: `sandbox worker exited with code ${code} before answering` }));
  });
}

/**
 * Real re-execution of a deterministic task's declared function against its
 * declared input, then a real sha256 of the canonical output — never a
 * fabricated match/mismatch.
 *
 * The function runs in fuel-instrumented QuickJS compiled to WebAssembly, in a
 * worker thread. That gives two things at once: a real isolation boundary on
 * any host (the guest has no file system, network, process or Node APIs, and
 * cannot see this process's memory or environment), and one identical,
 * deterministically metered JavaScript engine for every re-executor, so the
 * same function yields the same bytes — or the same budget error — everywhere.
 *
 * Throws a plain Error when the function itself fails (it threw, or exceeded
 * an engine limit) — the caller records that as a mismatch. Throws
 * ReplayInfrastructureError when this host could not complete the replay.
 */
export async function runDeterministicFunction(
  functionSource: string,
  input: unknown
): Promise<{ outputHash: string; output: unknown; engine: string }> {
  const result = await runInWorker(functionSource, JSON.stringify(input));
  if (result.kind === "host-error") throw new ReplayInfrastructureError(result.reason);
  if (result.kind === "guest-error") throw new Error(result.reason);
  if (result.outputJson !== null && Buffer.byteLength(result.outputJson) > MAX_OUTPUT_BYTES) {
    throw new Error(`output larger than ${MAX_OUTPUT_BYTES} bytes`);
  }
  const output = result.outputJson === null ? null : JSON.parse(result.outputJson);
  return { outputHash: canonicalHash(output), output, engine: REPLAY_ENGINE };
}
