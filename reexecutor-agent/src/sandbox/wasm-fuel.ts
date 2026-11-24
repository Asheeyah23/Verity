import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** Export name of the mutable i64 fuel counter injected into the WASM module. */
export const FUEL_GLOBAL_EXPORT = "__verity_fuel";

/** Initial fuel value baked into the WASM global so module/runtime startup
 * runs without trapping; the worker sets the actual per-replay budget right
 * before evaluating guest input and code. */
const STARTUP_FUEL = 0x7fffffffffffffffn;

/** Expected SHA-256 of the stock quickjs-emscripten@0.32.0 release-sync WASM. */
export const STOCK_QUICKJS_WASM_SHA256 =
  "105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232";

/** Expected SHA-256 of the fuel-instrumented QuickJS WASM produced by
 * `instrumentWasmFuel` from the pinned stock binary above. */
export const INSTRUMENTED_QUICKJS_WASM_SHA256 =
  "94fd86a5ad030eac3b69bb2ac767e77e9b548b6bf5e953d501b74b8f02f2ab37";

function readUleb(buf: Uint8Array, pos: number): [number, number] {
  let val = 0;
  let shift = 0;
  while (true) {
    if (pos >= buf.length) throw new Error("unexpected EOF reading uleb128");
    const b = buf[pos++]!;
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [val >>> 0, pos];
    shift += 7;
    if (shift > 35) throw new Error("uleb128 overflow");
  }
}

function readSleb32(buf: Uint8Array, pos: number): [number, number] {
  let val = 0;
  let shift = 0;
  while (true) {
    if (pos >= buf.length) throw new Error("unexpected EOF reading sleb32");
    const b = buf[pos++]!;
    val |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) {
      if (shift < 32 && (b & 0x40) !== 0) val |= ~0 << shift;
      return [val, pos];
    }
    if (shift > 35) throw new Error("sleb32 overflow");
  }
}

function skipSleb64(buf: Uint8Array, pos: number): number {
  let count = 0;
  while (true) {
    if (pos >= buf.length) throw new Error("unexpected EOF reading sleb64");
    const b = buf[pos++]!;
    count++;
    if ((b & 0x80) === 0) return pos;
    if (count >= 10) throw new Error("sleb64 overflow");
  }
}

function writeUleb(val: number): number[] {
  const out: number[] = [];
  let v = val >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function writeSleb64(val: bigint): number[] {
  const out: number[] = [];
  let v = val;
  while (true) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    const done =
      (v === 0n && (byte & 0x40) === 0) ||
      (v === -1n && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) break;
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function encodeSection(id: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes([
    Uint8Array.of(id),
    Uint8Array.from(writeUleb(payload.length)),
    payload,
  ]);
}

function isSimpleBlockType(b: number): boolean {
  return (
    b === 0x40 ||
    b === 0x7f ||
    b === 0x7e ||
    b === 0x7d ||
    b === 0x7c ||
    b === 0x7b ||
    b === 0x70 ||
    b === 0x6f
  );
}

interface WasmSection {
  id: number;
  payload: Uint8Array;
}

function insertSectionInOrder(sections: WasmSection[], section: WasmSection): void {
  // Standard WebAssembly sections appear in ascending section ID order, except
  // DataCount (12) which sits immediately before Code (10).
  const order = (id: number) => (id === 12 ? 9.5 : id);
  const target = order(section.id);
  let idx = sections.length;
  for (let i = 0; i < sections.length; i++) {
    if (sections[i]!.id !== 0 && order(sections[i]!.id) > target) {
      idx = i;
      break;
    }
  }
  sections.splice(idx, 0, section);
}

/**
 * Deterministically instruments a WebAssembly binary with a fuel counter global
 * exported as `__verity_fuel` (mutable `i64`):
 *
 * - Every defined function entry decrements fuel by 1.
 * - Every `loop` header (entered initially and on every back-edge) decrements
 *   fuel by 1.
 * - Every `memory.copy` and `memory.fill` calls a helper that decrements fuel
 *   by `1 + (n >>> 4)` (1 unit per 16 bytes) and leaves the length `n` intact.
 *
 * Whenever the counter drops below zero, the module executes `unreachable`,
 * trapping identically on every host regardless of CPU speed or JIT tier.
 */
export function instrumentWasmFuel(wasmBytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    wasmBytes.length < 8 ||
    wasmBytes[0] !== 0x00 ||
    wasmBytes[1] !== 0x61 ||
    wasmBytes[2] !== 0x73 ||
    wasmBytes[3] !== 0x6d ||
    wasmBytes[4] !== 0x01 ||
    wasmBytes[5] !== 0x00 ||
    wasmBytes[6] !== 0x00 ||
    wasmBytes[7] !== 0x00
  ) {
    throw new Error("invalid WebAssembly binary header");
  }

  const sections: WasmSection[] = [];
  let pos = 8;
  while (pos < wasmBytes.length) {
    const id = wasmBytes[pos++]!;
    const [len, next] = readUleb(wasmBytes, pos);
    if (next + len > wasmBytes.length) {
      throw new Error(`section ${id} extends past end of WASM binary`);
    }
    sections.push({ id, payload: wasmBytes.subarray(next, next + len) });
    pos = next + len;
  }

  // Count imported functions and imported globals so newly appended indices
  // never collide with existing ones.
  let importedFuncs = 0;
  let importedGlobals = 0;
  const importSec = sections.find((s) => s.id === 2);
  if (importSec) {
    const b = importSec.payload;
    let p = 0;
    let count: number;
    [count, p] = readUleb(b, p);
    for (let i = 0; i < count; i++) {
      let n: number;
      [n, p] = readUleb(b, p);
      p += n;
      [n, p] = readUleb(b, p);
      p += n;
      const kind = b[p++]!;
      if (kind === 0) {
        [, p] = readUleb(b, p);
        importedFuncs++;
      } else if (kind === 1) {
        p++; // reftype
        const flags = b[p++]!;
        [, p] = readUleb(b, p);
        if (flags & 1) [, p] = readUleb(b, p);
      } else if (kind === 2) {
        const flags = b[p++]!;
        [, p] = readUleb(b, p);
        if (flags & 1) [, p] = readUleb(b, p);
      } else if (kind === 3) {
        p += 2; // valtype + mutability
        importedGlobals++;
      } else {
        throw new Error(`unsupported WASM import kind ${kind}`);
      }
    }
  }

  // Locate an existing (param i32) (result i32) function type for the bulk
  // memory charging helper, or append one to the Type section (id 1).
  let typeSec = sections.find((s) => s.id === 1);
  let memChargeTypeIdx = -1;
  if (!typeSec) {
    memChargeTypeIdx = 0;
    typeSec = {
      id: 1,
      payload: Uint8Array.of(0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f),
    };
    insertSectionInOrder(sections, typeSec);
  } else {
    const b = typeSec.payload;
    let p = 0;
    let count: number;
    [count, p] = readUleb(b, p);
    const bodyStart = p;
    for (let i = 0; i < count; i++) {
      if (b[p++] !== 0x60) throw new Error("expected function type tag 0x60");
      let np: number;
      let nr: number;
      [np, p] = readUleb(b, p);
      const params = b.subarray(p, p + np);
      p += np;
      [nr, p] = readUleb(b, p);
      const results = b.subarray(p, p + nr);
      p += nr;
      if (
        memChargeTypeIdx === -1 &&
        np === 1 &&
        params[0] === 0x7f &&
        nr === 1 &&
        results[0] === 0x7f
      ) {
        memChargeTypeIdx = i;
      }
    }
    if (memChargeTypeIdx === -1) {
      memChargeTypeIdx = count;
      typeSec.payload = concatBytes([
        Uint8Array.from(writeUleb(count + 1)),
        b.subarray(bodyStart),
        Uint8Array.of(0x60, 0x01, 0x7f, 0x01, 0x7f),
      ]);
    }
  }

  // Append the bulk-memory helper function to the Function section (id 3).
  let funcSec = sections.find((s) => s.id === 3);
  let helperFuncIdx: number;
  if (!funcSec) {
    helperFuncIdx = importedFuncs;
    funcSec = {
      id: 3,
      payload: concatBytes([
        Uint8Array.of(0x01),
        Uint8Array.from(writeUleb(memChargeTypeIdx)),
      ]),
    };
    insertSectionInOrder(sections, funcSec);
  } else {
    const b = funcSec.payload;
    const [count, start] = readUleb(b, 0);
    helperFuncIdx = importedFuncs + count;
    funcSec.payload = concatBytes([
      Uint8Array.from(writeUleb(count + 1)),
      b.subarray(start),
      Uint8Array.from(writeUleb(memChargeTypeIdx)),
    ]);
  }

  // Append a mutable i64 fuel global initialized to STARTUP_FUEL (id 6).
  const newGlobal = Uint8Array.from([
    0x7e, // i64
    0x01, // mutable
    0x42,
    ...writeSleb64(STARTUP_FUEL),
    0x0b, // end
  ]);
  let globalSec = sections.find((s) => s.id === 6);
  let fuelGlobalIdx: number;
  if (!globalSec) {
    fuelGlobalIdx = importedGlobals;
    globalSec = {
      id: 6,
      payload: concatBytes([Uint8Array.of(0x01), newGlobal]),
    };
    insertSectionInOrder(sections, globalSec);
  } else {
    const b = globalSec.payload;
    const [count, start] = readUleb(b, 0);
    fuelGlobalIdx = importedGlobals + count;
    globalSec.payload = concatBytes([
      Uint8Array.from(writeUleb(count + 1)),
      b.subarray(start),
      newGlobal,
    ]);
  }

  // Export the fuel global as `__verity_fuel` in the Export section (id 7).
  const exportName = Buffer.from(FUEL_GLOBAL_EXPORT, "utf8");
  const newExport = concatBytes([
    Uint8Array.from(writeUleb(exportName.length)),
    exportName,
    Uint8Array.of(0x03), // global export
    Uint8Array.from(writeUleb(fuelGlobalIdx)),
  ]);
  let exportSec = sections.find((s) => s.id === 7);
  if (!exportSec) {
    exportSec = {
      id: 7,
      payload: concatBytes([Uint8Array.of(0x01), newExport]),
    };
    insertSectionInOrder(sections, exportSec);
  } else {
    const b = exportSec.payload;
    const [count, start] = readUleb(b, 0);
    exportSec.payload = concatBytes([
      Uint8Array.from(writeUleb(count + 1)),
      b.subarray(start),
      newExport,
    ]);
  }

  const fuelIdxLeb = writeUleb(fuelGlobalIdx);
  // Decrement `$fuel` by 1 and trap if `$fuel < 0`. Leaves operand stack
  // untouched and requires no extra locals.
  const chargeOne = Uint8Array.from([
    0x23, ...fuelIdxLeb, // global.get $fuel
    0x42, 0x01,          // i64.const 1
    0x7d,                // i64.sub
    0x24, ...fuelIdxLeb, // global.set $fuel
    0x23, ...fuelIdxLeb, // global.get $fuel
    0x42, 0x00,          // i64.const 0
    0x53,                // i64.lt_s
    0x04, 0x40,          // if (void)
    0x00,                //   unreachable
    0x0b,                // end
  ]);

  const callChargeMem = Uint8Array.from([0x10, ...writeUleb(helperFuncIdx)]);

  // Helper `(param $n i32) (result i32)`: charges `1 + (u32($n) >> 4)` fuel
  // (1 unit per 16 bytes) and returns `$n` unchanged for memory.copy/fill.
  const helperCode = Uint8Array.from([
    0x00,                // 0 local declarations
    0x23, ...fuelIdxLeb, // global.get $fuel
    0x20, 0x00,          // local.get 0 ($n)
    0xad,                // i64.extend_i32_u
    0x42, 0x04,          // i64.const 4
    0x88,                // i64.shr_u
    0x42, 0x01,          // i64.const 1
    0x7c,                // i64.add
    0x7d,                // i64.sub
    0x24, ...fuelIdxLeb, // global.set $fuel
    0x23, ...fuelIdxLeb, // global.get $fuel
    0x42, 0x00,          // i64.const 0
    0x53,                // i64.lt_s
    0x04, 0x40,          // if (void)
    0x00,                //   unreachable
    0x0b,                // end
    0x20, 0x00,          // local.get 0 ($n)
    0x0b,                // end function
  ]);

  // Instrument every function body in the Code section (id 10).
  let codeSec = sections.find((s) => s.id === 10);
  if (!codeSec) {
    codeSec = {
      id: 10,
      payload: concatBytes([
        Uint8Array.of(0x01),
        Uint8Array.from(writeUleb(helperCode.length)),
        helperCode,
      ]),
    };
    insertSectionInOrder(sections, codeSec);
  } else {
    const b = codeSec.payload;
    let p = 0;
    let fcount: number;
    [fcount, p] = readUleb(b, p);
    const outParts: Uint8Array[] = [Uint8Array.from(writeUleb(fcount + 1))];

    for (let fi = 0; fi < fcount; fi++) {
      let bodySize: number;
      [bodySize, p] = readUleb(b, p);
      const bodyStart = p;
      const bodyEnd = p + bodySize;
      if (bodyEnd > b.length) {
        throw new Error(`function ${fi} extends past end of code section`);
      }

      let lcount: number;
      [lcount, p] = readUleb(b, p);
      for (let i = 0; i < lcount; i++) {
        [, p] = readUleb(b, p);
        p++; // valtype
      }

      const chunks: Uint8Array[] = [b.subarray(bodyStart, p), chargeOne];
      let sliceStart = p;
      let depth = 1;

      while (p < bodyEnd) {
        const opStart = p;
        const op = b[p++]!;
        if (op === 0x02 || op === 0x03 || op === 0x04) {
          const bt = b[p]!;
          if (isSimpleBlockType(bt)) {
            p++;
          } else {
            [, p] = readSleb32(b, p);
          }
          depth++;
          if (op === 0x03) {
            chunks.push(b.subarray(sliceStart, p), chargeOne);
            sliceStart = p;
          }
        } else if (op === 0x0b) {
          depth--;
        } else if (
          op === 0x00 ||
          op === 0x01 ||
          op === 0x05 ||
          op === 0x0f ||
          op === 0x1a ||
          op === 0x1b ||
          op === 0xd1
        ) {
          // no immediates
        } else if (
          op === 0x0c ||
          op === 0x0d ||
          op === 0x10 ||
          op === 0xd2 ||
          (op >= 0x20 && op <= 0x26)
        ) {
          [, p] = readUleb(b, p);
        } else if (op === 0xd0) {
          p++; // heaptype
        } else if (op === 0x0e) {
          let cnt: number;
          [cnt, p] = readUleb(b, p);
          for (let i = 0; i <= cnt; i++) [, p] = readUleb(b, p);
        } else if (op === 0x11) {
          [, p] = readUleb(b, p);
          [, p] = readUleb(b, p);
        } else if (op === 0x1c) {
          let cnt: number;
          [cnt, p] = readUleb(b, p);
          p += cnt;
        } else if (op >= 0x28 && op <= 0x3e) {
          [, p] = readUleb(b, p);
          [, p] = readUleb(b, p);
        } else if (op === 0x3f || op === 0x40) {
          [, p] = readUleb(b, p);
        } else if (op === 0x41) {
          [, p] = readSleb32(b, p);
        } else if (op === 0x42) {
          p = skipSleb64(b, p);
        } else if (op === 0x43) {
          p += 4;
        } else if (op === 0x44) {
          p += 8;
        } else if (op >= 0x45 && op <= 0xc4) {
          // numeric, conversion, and sign-extension ops have no immediates
        } else if (op === 0xfc) {
          let sub: number;
          [sub, p] = readUleb(b, p);
          if (sub <= 7) {
            // trunc_sat ops
          } else if (sub === 8 || sub === 10 || sub === 12 || sub === 14) {
            [, p] = readUleb(b, p);
            [, p] = readUleb(b, p);
            if (sub === 10) {
              // memory.copy: charge proportional to byte length before executing
              chunks.push(b.subarray(sliceStart, opStart), callChargeMem);
              sliceStart = opStart;
            }
          } else if (
            sub === 9 ||
            sub === 11 ||
            sub === 13 ||
            sub === 15 ||
            sub === 16 ||
            sub === 17
          ) {
            [, p] = readUleb(b, p);
            if (sub === 11) {
              // memory.fill: charge proportional to byte length before executing
              chunks.push(b.subarray(sliceStart, opStart), callChargeMem);
              sliceStart = opStart;
            }
          } else {
            throw new Error(
              `unsupported WASM 0xfc subopcode ${sub} in function ${fi}`
            );
          }
        } else {
          throw new Error(
            `unsupported WASM opcode 0x${op.toString(16)} in function ${fi}`
          );
        }
      }

      if (depth !== 0 || p !== bodyEnd) {
        throw new Error(
          `malformed WASM function ${fi}: depth=${depth}, pos=${p}, end=${bodyEnd}`
        );
      }

      chunks.push(b.subarray(sliceStart, bodyEnd));
      const newBody = concatBytes(chunks);
      outParts.push(Uint8Array.from(writeUleb(newBody.length)), newBody);
    }

    outParts.push(Uint8Array.from(writeUleb(helperCode.length)), helperCode);
    codeSec.payload = concatBytes(outParts);
  }

  return concatBytes([
    wasmBytes.subarray(0, 8),
    ...sections.map((s) => encodeSection(s.id, s.payload)),
  ]);
}

let cachedQuickJSWasm: { wasmBinary: Uint8Array<ArrayBuffer>; sha256: string } | null = null;

/**
 * Loads the pinned `quickjs-emscripten` release-sync WASM binary, verifies its
 * SHA-256, instruments it with deterministic fuel metering, and caches the
 * result for the lifetime of this process.
 */
export function loadInstrumentedQuickJSWasm(): {
  wasmBinary: Uint8Array<ArrayBuffer>;
  sha256: string;
} {
  if (cachedQuickJSWasm) return cachedQuickJSWasm;

  const localRequire = createRequire(import.meta.url);
  const qjsPkg = localRequire.resolve("quickjs-emscripten/package.json");
  const wasmPath = createRequire(qjsPkg).resolve(
    "@jitl/quickjs-wasmfile-release-sync/wasm"
  );
  const stockBytes = readFileSync(wasmPath);
  const stockSha = createHash("sha256").update(stockBytes).digest("hex");
  if (stockSha !== STOCK_QUICKJS_WASM_SHA256) {
    throw new Error(
      `unexpected quickjs-emscripten WASM sha256: expected ${STOCK_QUICKJS_WASM_SHA256}, got ${stockSha}`
    );
  }

  const wasmBinary = instrumentWasmFuel(stockBytes);
  const sha256 = createHash("sha256").update(wasmBinary).digest("hex");
  if (sha256 !== INSTRUMENTED_QUICKJS_WASM_SHA256) {
    throw new Error(
      `unexpected instrumented QuickJS WASM sha256: expected ${INSTRUMENTED_QUICKJS_WASM_SHA256}, got ${sha256}`
    );
  }

  cachedQuickJSWasm = { wasmBinary, sha256 };
  return cachedQuickJSWasm;
}
