import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  FUEL_GLOBAL_EXPORT,
  INSTRUMENTED_QUICKJS_WASM_SHA256,
  instrumentWasmFuel,
  loadInstrumentedQuickJSWasm,
} from "./wasm-fuel.js";

function section(id: number, payload: number[]): number[] {
  return [id, payload.length, ...payload];
}

function wasmModule(sections: number[][]): Uint8Array {
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
}

test("loadInstrumentedQuickJSWasm produces a valid, pinned WASM binary", () => {
  const first = loadInstrumentedQuickJSWasm();
  const second = loadInstrumentedQuickJSWasm();
  assert.equal(first, second, "cached instance should be reused");
  assert.equal(first.sha256, INSTRUMENTED_QUICKJS_WASM_SHA256);
  assert.equal(
    createHash("sha256").update(first.wasmBinary).digest("hex"),
    INSTRUMENTED_QUICKJS_WASM_SHA256
  );
  assert.equal(WebAssembly.validate(first.wasmBinary), true);
});

test("instrumentWasmFuel meters loop back-edges deterministically at the exact boundary", () => {
  // Module with one function `spin(n: i32) -> i32` that executes a WASM loop `n` times.
  // Cost: 1 (function entry) + n (loop entries/back-edges).
  const body = [
    0x00, // 0 locals
    0x03, 0x40, // loop (void)
    0x20, 0x00, // local.get 0
    0x41, 0x01, // i32.const 1
    0x6b,       // i32.sub
    0x22, 0x00, // local.tee 0
    0x0d, 0x00, // br_if 0
    0x0b,       // end loop
    0x20, 0x00, // local.get 0
    0x0b,       // end func
  ];
  const raw = wasmModule([
    section(1, [0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f]), // type 0: (i32) -> i32
    section(3, [0x01, 0x00]), // func 0: type 0
    section(7, [0x01, 0x04, ...Buffer.from("spin"), 0x00, 0x00]), // export "spin"
    section(10, [0x01, body.length, ...body]),
  ]);

  const instrumented = instrumentWasmFuel(raw);
  assert.equal(WebAssembly.validate(instrumented), true);

  const instance = new WebAssembly.Instance(new WebAssembly.Module(instrumented));
  const spin = instance.exports.spin as (n: number) => number;
  const fuel = instance.exports[FUEL_GLOBAL_EXPORT] as WebAssembly.Global<"i64">;

  // 10 iterations need 1 (entry) + 10 (loop) = 11 fuel.
  fuel.value = 11n;
  assert.equal(spin(10), 0);
  assert.equal(fuel.value, 0n);

  // 10 fuel is 1 unit short: must trap with fuel < 0.
  fuel.value = 10n;
  assert.throws(() => spin(10), WebAssembly.RuntimeError);
  assert.equal(fuel.value, -1n);
});

test("instrumentWasmFuel meters recursion without loops", () => {
  // Module with recursive `rec(n: i32) -> i32`: if (n == 0) return 0; return rec(n - 1);
  // Cost: n + 1 function entries.
  const body = [
    0x00, // 0 locals
    0x20, 0x00, // local.get 0
    0x45,       // i32.eqz
    0x04, 0x7f, // if (result i32)
    0x41, 0x00, //   i32.const 0
    0x05,       // else
    0x20, 0x00, //   local.get 0
    0x41, 0x01, //   i32.const 1
    0x6b,       //   i32.sub
    0x10, 0x00, //   call 0
    0x0b,       // end if
    0x0b,       // end func
  ];
  const raw = wasmModule([
    section(1, [0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f]),
    section(3, [0x01, 0x00]),
    section(7, [0x01, 0x03, ...Buffer.from("rec"), 0x00, 0x00]),
    section(10, [0x01, body.length, ...body]),
  ]);

  const instrumented = instrumentWasmFuel(raw);
  assert.equal(WebAssembly.validate(instrumented), true);

  const instance = new WebAssembly.Instance(new WebAssembly.Module(instrumented));
  const rec = instance.exports.rec as (n: number) => number;
  const fuel = instance.exports[FUEL_GLOBAL_EXPORT] as WebAssembly.Global<"i64">;

  fuel.value = 6n;
  assert.equal(rec(5), 0);
  assert.equal(fuel.value, 0n);

  fuel.value = 5n;
  assert.throws(() => rec(5), WebAssembly.RuntimeError);
  assert.equal(fuel.value, -1n);
});

test("instrumentWasmFuel meters memory.fill and memory.copy proportionally to byte length", () => {
  // Module exporting `mem`, `fill(dst, val, len)`, and `copy(dst, src, len)`.
  const fillBody = [
    0x00,
    0x20, 0x00, // dst
    0x20, 0x01, // val
    0x20, 0x02, // len
    0xfc, 0x0b, 0x00, // memory.fill 0
    0x0b,
  ];
  const copyBody = [
    0x00,
    0x20, 0x00, // dst
    0x20, 0x01, // src
    0x20, 0x02, // len
    0xfc, 0x0a, 0x00, 0x00, // memory.copy 0 0
    0x0b,
  ];
  const raw = wasmModule([
    section(1, [0x01, 0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x00]), // (i32, i32, i32) -> ()
    section(3, [0x02, 0x00, 0x00]),
    section(5, [0x01, 0x00, 0x01]), // 1 page memory
    section(7, [
      0x03,
      0x03, ...Buffer.from("mem"), 0x02, 0x00,
      0x04, ...Buffer.from("fill"), 0x00, 0x00,
      0x04, ...Buffer.from("copy"), 0x00, 0x01,
    ]),
    section(10, [0x02, fillBody.length, ...fillBody, copyBody.length, ...copyBody]),
  ]);

  const instrumented = instrumentWasmFuel(raw);
  assert.equal(WebAssembly.validate(instrumented), true);

  const instance = new WebAssembly.Instance(new WebAssembly.Module(instrumented));
  const mem = new Uint8Array((instance.exports.mem as WebAssembly.Memory).buffer);
  const fill = instance.exports.fill as (d: number, v: number, n: number) => void;
  const copy = instance.exports.copy as (d: number, s: number, n: number) => void;
  const fuel = instance.exports[FUEL_GLOBAL_EXPORT] as WebAssembly.Global<"i64">;

  // 160 bytes => 1 (func entry) + (1 + (160 >> 4)) = 12 fuel.
  fuel.value = 12n;
  fill(0, 0xab, 160);
  assert.equal(fuel.value, 0n);
  assert.equal(mem[0], 0xab);
  assert.equal(mem[159], 0xab);
  assert.equal(mem[160], 0x00);

  fuel.value = 12n;
  copy(200, 0, 160);
  assert.equal(fuel.value, 0n);
  assert.equal(mem[200], 0xab);
  assert.equal(mem[359], 0xab);

  // 1 unit short traps before executing memory.fill.
  fuel.value = 11n;
  assert.throws(() => fill(400, 0xcd, 160), WebAssembly.RuntimeError);
  assert.ok(fuel.value < 0n);
  assert.equal(mem[400], 0x00);
});

test("instrumentWasmFuel rejects malformed headers and unsupported opcodes", () => {
  assert.throws(() => instrumentWasmFuel(new Uint8Array([1, 2, 3, 4])), /invalid WebAssembly/);

  const badBody = [0x00, 0xfd, 0x00, 0x0b]; // SIMD opcode 0xfd
  const badMod = wasmModule([
    section(1, [0x01, 0x60, 0x00, 0x00]),
    section(3, [0x01, 0x00]),
    section(10, [0x01, badBody.length, ...badBody]),
  ]);
  assert.throws(() => instrumentWasmFuel(badMod), /unsupported WASM opcode 0xfd/);
});
