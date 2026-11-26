import assert from "node:assert/strict";
import test from "node:test";
import { StrKey } from "@stellar/stellar-sdk";
import { assertBondAssetMatchesGate, checkBondAsset } from "./bond-asset.js";

const contract = (fill: number) => StrKey.encodeContract(Buffer.alloc(32, fill));
const GATE = contract(1);
const NATIVE = contract(2);
const USDC = contract(3);

test("the configured asset is right when it is the one the gate reports", () => {
  assert.deepEqual(checkBondAsset(NATIVE, NATIVE, GATE), { ok: true });
  assert.deepEqual(checkBondAsset(USDC, USDC, GATE), { ok: true });
});

test("a different asset is refused, naming both and the gate", () => {
  const check = checkBondAsset(USDC, NATIVE, GATE);
  assert.equal(check.ok, false);
  assert.ok(!check.ok);
  assert.match(check.message, /^BOND_ASSET_CONTRACT_ID is /);
  for (const id of [NATIVE, USDC, GATE]) assert.ok(check.message.includes(id), id);
  // Which is which: the configured one first, the gate's own after "takes its bonds in".
  assert.ok(check.message.indexOf(NATIVE) < check.message.indexOf(USDC));
  assert.match(check.message, new RegExp(`takes its bonds in ${USDC}`));
});

test("a gate that reports no asset is refused", () => {
  for (const none of [null, undefined, ""]) {
    const check = checkBondAsset(none, NATIVE, GATE);
    assert.equal(check.ok, false, String(none));
    assert.ok(!check.ok);
    assert.match(check.message, /reports no bond asset/);
    assert.ok(check.message.includes(GATE));
  }
});

test("ids are compared exactly", () => {
  assert.equal(checkBondAsset(NATIVE.toLowerCase(), NATIVE, GATE).ok, false);
  assert.equal(checkBondAsset(`${NATIVE} `, NATIVE, GATE).ok, false);
});

const deps = (read: () => Promise<string | null | undefined>) => {
  const warnings: string[] = [];
  return {
    warnings,
    deps: { read, configured: NATIVE, gateId: GATE, warn: (m: string) => warnings.push(m) },
  };
};

test("startup goes ahead, silently, when the gate agrees", async () => {
  const { deps: d, warnings } = deps(async () => NATIVE);
  await assertBondAssetMatchesGate(d);
  assert.deepEqual(warnings, []);
});

test("startup stops when the gate takes another asset", async () => {
  const { deps: d, warnings } = deps(async () => USDC);
  await assert.rejects(assertBondAssetMatchesGate(d), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes(NATIVE) && err.message.includes(USDC));
    return true;
  });
  assert.deepEqual(warnings, []);
});

test("startup stops when the gate reports no asset", async () => {
  const { deps: d } = deps(async () => undefined);
  await assert.rejects(assertBondAssetMatchesGate(d), /reports no bond asset/);
});

test("startup goes ahead with a warning when the gate cannot be asked", async () => {
  // The RPC is down, or the gate was deployed before it had the getter.
  const { deps: d, warnings } = deps(async () => {
    throw new Error("HostError: Error(WasmVm, MissingValue) trying to invoke non-existent contract function, get_bond_asset");
  });
  await assertBondAssetMatchesGate(d);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /Could not read EscrowGate/);
  assert.ok(warnings[0]?.includes(GATE));
  assert.ok(warnings[0]?.includes(NATIVE));
  assert.match(warnings[0] ?? "", /is not verified: HostError/);
});

test("a failure that is not an Error is still reported", async () => {
  const { deps: d, warnings } = deps(async () => {
    throw "socket hang up";
  });
  await assertBondAssetMatchesGate(d);
  assert.match(warnings[0] ?? "", /is not verified: socket hang up$/);
});
