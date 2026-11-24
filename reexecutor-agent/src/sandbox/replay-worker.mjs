// Runs ONE replay inside a fuel-instrumented QuickJS WebAssembly sandbox, in
// its own worker thread, and posts a single message back. Plain JavaScript on
// purpose: the worker is started without the TypeScript loader and imports
// nothing but the engine, so the guest code's only neighbours are this file
// and Node's worker runtime — not the agent, its environment, or its signing
// key.
//
// Outcomes:
//   { kind: "ok", outputJson }       the function returned (null = undefined)
//   { kind: "guest-error", reason }  the function threw, or hit an engine
//                                    limit (memory, stack, or WASM fuel).
//                                    Engine limits are enforced by the same
//                                    instrumented WASM build on every
//                                    re-executor, so this is identical on all
//                                    of them.
//   { kind: "host-error", reason }   this host failed, not the function.
import { parentPort, workerData } from "node:worker_threads";
import {
  RELEASE_SYNC,
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from "quickjs-emscripten";

const { functionSource, inputJson, limits, wasmBinary, fuelGlobalExport } = workerData;

// Date and Math.random are the engine's only sources of non-determinism.
// A replay must give every honest re-executor the same answer, so a function
// that reads the clock or rolls dice is not replayable and gets neither.
const PRELUDE = `
delete globalThis.Date;
delete Math.random;
const __input = JSON.parse(__inputJson);
delete globalThis.__inputJson;
`;

let fuelGlobal = null;

try {
  // A fresh WASM instance per replay: nothing a previous function did to the
  // engine can reach this one.
  const wasmModule = await WebAssembly.compile(wasmBinary);
  const variant = newVariant(RELEASE_SYNC, {
    emscriptenModule: {
      instantiateWasm(imports, onSuccess) {
        const instance = new WebAssembly.Instance(wasmModule, imports);
        fuelGlobal = instance.exports[fuelGlobalExport] ?? null;
        onSuccess(instance, wasmModule);
        return instance.exports;
      },
    },
  });
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
  if (!fuelGlobal || typeof fuelGlobal.value !== "bigint") {
    throw new Error(`instrumented WASM did not export mutable i64 global ${fuelGlobalExport}`);
  }

  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);

  const context = runtime.newContext();
  // Activate the deterministic WASM fuel budget before any submission-dependent
  // work (input marshalling, guest code, JSON serialization, or error dumping).
  fuelGlobal.value = BigInt(limits.fuel);

  const input = context.newString(inputJson);
  context.setProp(context.global, "__inputJson", input);
  input.dispose();

  const result = context.evalCode(
    `${PRELUDE}JSON.stringify((function(input){ ${functionSource}\n})(__input));`,
    "replay-function.js"
  );
  if (result.error) {
    const error = context.dump(result.error);
    result.error.dispose();
    const reason = `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
    parentPort.postMessage({ kind: "guest-error", reason });
  } else {
    const outputJson = context.typeof(result.value) === "string" ? context.getString(result.value) : null;
    result.value.dispose();
    parentPort.postMessage({ kind: "ok", outputJson });
  }
} catch (err) {
  // Once the WASM fuel counter drops below zero, the trap (and any follow-on
  // engine error from a half-unwound frame) is a deterministic guest error,
  // never a host failure. Never touch or dispose the trapped runtime here;
  // this worker exits immediately.
  if (fuelGlobal !== null && fuelGlobal.value < 0n) {
    parentPort.postMessage({ kind: "guest-error", reason: "computation budget exceeded" });
  } else {
    // Anything thrown out of the engine while fuel remains is the host's
    // stack or memory giving way, which differs from machine to machine
    // and so must never be turned into a vote.
    parentPort.postMessage({ kind: "host-error", reason: String(err?.message ?? err) });
  }
}
