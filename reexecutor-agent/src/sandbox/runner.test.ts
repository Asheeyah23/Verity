import test from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS,
  REPLAY_ENGINE,
  ReplayInfrastructureError,
  runDeterministicFunction,
} from "./runner.js";
import { INSTRUMENTED_QUICKJS_WASM_SHA256 } from "./wasm-fuel.js";

// Each call starts a real worker and a fresh WebAssembly engine, so a case
// takes seconds. The timeout is well under the 20 s wall-clock kill switch.
const opts = { timeout: 15_000 };

async function rejectsAsGuestError(source: string, message: RegExp, input: unknown = {}) {
  await assert.rejects(runDeterministicFunction(source, input), (err: Error) => {
    assert.ok(!(err instanceof ReplayInfrastructureError), "must not be an infrastructure error");
    assert.match(err.message, message);
    return true;
  });
}

test("returns the output and its canonical hash", opts, async () => {
  const result = await runDeterministicFunction("return { doubled: input.n * 2 };", { n: 21 });
  assert.deepEqual(result.output, { doubled: 42 });
  // sha256 of {"doubled":42}, computed with sha256sum rather than from the sandbox.
  assert.equal(result.outputHash, "27d4958085af3032ba46babb9e0b71690f9e2cc745ff7bb403a3d54e12152f82");
  assert.match(result.engine, /^quickjs-emscripten@/);
  assert.equal(result.engine, REPLAY_ENGINE);
  assert.ok(result.engine.includes(`fuel=${LIMITS.fuel}`), "engine string must include fuel budget");
  assert.ok(
    result.engine.includes(`wasm=sha256:${INSTRUMENTED_QUICKJS_WASM_SHA256}`),
    "engine string must include pinned instrumented WASM hash"
  );
});

test("Date is not available", opts, async () => {
  const typeOf = await runDeterministicFunction("return typeof Date;", {});
  assert.equal(typeOf.output, "undefined");
  await rejectsAsGuestError("return new Date();", /Date/);
});

test("Math.random is not available", opts, async () => {
  const result = await runDeterministicFunction("return typeof Math.random;", {});
  assert.equal(result.output, "undefined");
});

test("a tight loop exceeds the computation budget", opts, async () => {
  await rejectsAsGuestError("while (true) {}", /computation budget exceeded/);
});

test("native Array.prototype.indexOf stall exceeds the computation budget", opts, async () => {
  await rejectsAsGuestError(
    "const a = new Array(2000000).fill(0); let c = 0; for (let i = 0; i < 100000; i++) c += a.indexOf(1); return c;",
    /computation budget exceeded/
  );
});

test("native Array.prototype.join stall exceeds the computation budget", opts, async () => {
  await rejectsAsGuestError(
    "const a = new Array(3000000).fill('x'); let c = 0; for (let i = 0; i < 10000; i++) c += a.join('').length; return c;",
    /computation budget exceeded/
  );
});

test("bulk memory TypedArray fill and copyWithin stalls exceed the computation budget", opts, async () => {
  await rejectsAsGuestError(
    "const a = new Uint8Array(20 * 1024 * 1024); for (let i = 0; i < 10000; i++) a.fill(i & 255); return a[0];",
    /computation budget exceeded/
  );
  await rejectsAsGuestError(
    "const a = new Uint8Array(20 * 1024 * 1024); for (let i = 0; i < 10000; i++) a.copyWithin(1, 0, a.length - 1); return a[0];",
    /computation budget exceeded/
  );
});

test("regex backtracking and throwing an error with a looping getter exceed the computation budget", opts, async () => {
  await rejectsAsGuestError(
    "return /^(a+)+$/.test('a'.repeat(30) + '!');",
    /computation budget exceeded/
  );
  await rejectsAsGuestError(
    "throw { get message() { while (true) {} } };",
    /computation budget exceeded/
  );
});

test("two consecutive runs at the exact fuel boundary give identical outcomes", opts, async () => {
  // With the pinned fuel-instrumented QuickJS WASM and fuel=25_000_000,
  // 775_098 iterations finish right inside the budget while 775_099 trap.
  const source = "let s = 0; for (let i = 0; i < input.n; i++) s += i; return s;";
  const exactMax = 775_098;

  const first = await runDeterministicFunction(source, { n: exactMax });
  const second = await runDeterministicFunction(source, { n: exactMax });
  assert.equal(first.output, 300388067253);
  assert.equal(second.output, first.output);
  assert.equal(second.outputHash, first.outputHash);

  await rejectsAsGuestError(source, /computation budget exceeded/, { n: exactMax + 1 });
  await rejectsAsGuestError(source, /computation budget exceeded/, { n: exactMax + 1 });
});

test("allocating past the memory limit fails", opts, async () => {
  await rejectsAsGuestError("const s = 'x'.repeat(70*1024*1024); return s.length;", /out of memory/);
});

test("runaway recursion hits the stack limit", opts, async () => {
  await rejectsAsGuestError("function f(){ return f() + 1; } return f();", /stack overflow/);
});

test("output over 1,000,000 bytes is rejected", opts, async () => {
  await rejectsAsGuestError("return 'x'.repeat(1100000);", /larger than 1000000 bytes/);
});

test("undefined and an empty body both hash as null", opts, async () => {
  // sha256 of null, computed with sha256sum.
  const nullHash = "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b";
  for (const source of ["return undefined;", ""]) {
    const result = await runDeterministicFunction(source, {});
    assert.equal(result.output, null);
    assert.equal(result.outputHash, nullHash);
  }
});

test("host globals are not reachable from the guest", opts, async () => {
  const result = await runDeterministicFunction(
    "return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Buffer];",
    {}
  );
  assert.deepEqual(result.output, ["undefined", "undefined", "undefined", "undefined", "undefined"]);
});

test("a throwing function is a guest error", opts, async () => {
  await rejectsAsGuestError("throw new Error('boom');", /^Error: boom$/);
});

test("a syntax error is a guest error", opts, async () => {
  await rejectsAsGuestError("return (;", /^SyntaxError/);
});

test("values JSON cannot represent are normalised", opts, async () => {
  const fn = await runDeterministicFunction("return () => 1;", {});
  assert.equal(fn.output, null);

  const mixed = await runDeterministicFunction("return {a: NaN, b: undefined, c: [undefined]};", {});
  assert.deepEqual(mixed.output, { a: null, c: [null] });
});

test("no state leaks from one replay to the next", opts, async () => {
  await runDeterministicFunction("globalThis.leak = 1; Array.prototype.foo = 1; return 1;", {});
  const result = await runDeterministicFunction("return [typeof globalThis.leak, typeof [].foo];", {});
  assert.deepEqual(result.output, ["undefined", "undefined"]);
});
