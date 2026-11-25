import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const GATE = StrKey.encodeContract(Buffer.alloc(32, 1));
const OTHER_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 2));

Object.assign(process.env, {
  SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: Networks.TESTNET,
  ESCROW_GATE_CONTRACT_ID: GATE,
  ZK_VERIFIER_REGISTRY_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  BOND_ASSET_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32)),
  DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  KEEPER_SECRET_KEY: Keypair.random().secret(),
  JWT_SECRET: "a".repeat(32),
  WEB_AUTH_DOMAIN: "localhost:3001",
  HOME_DOMAIN: "localhost",
});

const { parseGateCall, assertGateCall, assertSimulated, buildWithAccountCheck } = await import("./rpc.js");
const { contractErrorName } = await import("./actions.js");
const { HttpError } = await import("../http-error.js");

function expectHttpError(
  fn: () => unknown,
  status: number,
  message: string,
): void {
  assert.throws(
    fn,
    (e: unknown) =>
      e instanceof HttpError && e.statusCode === status && e.message === message,
  );
}

function buildTx(
  source: Keypair,
  operations: any[],
): ReturnType<TransactionBuilder["build"]> {
  const account = new Account(source.publicKey(), "0");
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  for (const op of operations) {
    builder.addOperation(op);
  }
  return builder.build();
}

describe("parseGateCall", () => {
  const source = Keypair.random();
  const otherAccount = Keypair.random();

  it('rejects invalid XDR with 400 "signed_transaction_xdr is not a valid transaction for this network"', () => {
    expectHttpError(
      () => parseGateCall("not xdr"),
      400,
      "signed_transaction_xdr is not a valid transaction for this network",
    );
  });

  it('rejects fee-bump transactions with 400 "fee-bump transactions are not relayed"', () => {
    const innerTx = buildTx(source, [
      Operation.invokeContractFunction({
        contract: GATE,
        function: "submit",
        args: [new Address(source.publicKey()).toScVal()],
      }),
    ]);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      otherAccount,
      "200",
      innerTx,
      Networks.TESTNET,
    );
    expectHttpError(
      () => parseGateCall(feeBump.toXDR()),
      400,
      "fee-bump transactions are not relayed",
    );
  });

  it('rejects zero operations with 400 "transaction must be a single EscrowGate contract call"', () => {
    const tx = buildTx(source, []);
    expectHttpError(
      () => parseGateCall(tx.toXDR()),
      400,
      "transaction must be a single EscrowGate contract call",
    );
  });

  it('rejects two invokeContractFunction operations with 400 "transaction must be a single EscrowGate contract call"', () => {
    const op = Operation.invokeContractFunction({
      contract: GATE,
      function: "submit",
      args: [new Address(source.publicKey()).toScVal()],
    });
    const tx = buildTx(source, [op, op]);
    expectHttpError(
      () => parseGateCall(tx.toXDR()),
      400,
      "transaction must be a single EscrowGate contract call",
    );
  });

  it('rejects payment operation with 400 "transaction must be a single EscrowGate contract call"', () => {
    const tx = buildTx(source, [
      Operation.payment({
        destination: otherAccount.publicKey(),
        asset: Asset.native(),
        amount: "1",
      }),
    ]);
    expectHttpError(
      () => parseGateCall(tx.toXDR()),
      400,
      "transaction must be a single EscrowGate contract call",
    );
  });

  it('rejects uploadContractWasm with 400 "transaction must be a single EscrowGate contract call"', () => {
    const tx = buildTx(source, [
      Operation.uploadContractWasm({ wasm: Buffer.from([0, 1, 2]) }),
    ]);
    expectHttpError(
      () => parseGateCall(tx.toXDR()),
      400,
      "transaction must be a single EscrowGate contract call",
    );
  });

  it('rejects operation source mismatch with 400 "operation source must be the transaction source"', () => {
    const tx = buildTx(source, [
      Operation.invokeContractFunction({
        contract: GATE,
        function: "submit",
        args: [new Address(source.publicKey()).toScVal()],
        source: otherAccount.publicKey(),
      }),
    ]);
    expectHttpError(
      () => parseGateCall(tx.toXDR()),
      400,
      "operation source must be the transaction source",
    );
  });

  it('rejects call to contract other than ESCROW_GATE_CONTRACT_ID with 400 "transaction does not call this deployment\'s EscrowGate contract"', () => {
    const tx = buildTx(source, [
      Operation.invokeContractFunction({
        contract: OTHER_CONTRACT,
        function: "submit",
        args: [new Address(source.publicKey()).toScVal()],
      }),
    ]);
    expectHttpError(
      () => parseGateCall(tx.toXDR()),
      400,
      "transaction does not call this deployment's EscrowGate contract",
    );
  });

  it("accepts operation when operation source equals transaction source", () => {
    const tx = buildTx(source, [
      Operation.invokeContractFunction({
        contract: GATE,
        function: "submit",
        args: [new Address(source.publicKey()).toScVal()],
        source: source.publicKey(),
      }),
    ]);
    const call = parseGateCall(tx.toXDR());
    assert.equal(call.source, source.publicKey());
    assert.equal(call.fn, "submit");
  });

  it("accepts operation when no operation source is provided", () => {
    const tx = buildTx(source, [
      Operation.invokeContractFunction({
        contract: GATE,
        function: "submit",
        args: [new Address(source.publicKey()).toScVal()],
      }),
    ]);
    const call = parseGateCall(tx.toXDR());
    assert.equal(call.source, source.publicKey());
    assert.equal(call.fn, "submit");
  });

  it("decodes valid call args and preserves hash before and after signing", () => {
    const unsignedTx = buildTx(source, [
      Operation.invokeContractFunction({
        contract: GATE,
        function: "submit",
        args: [
          new Address(source.publicKey()).toScVal(),
          nativeToScVal(7, { type: "u32" }),
          nativeToScVal(100000000000000000000n, { type: "i128" }),
          nativeToScVal("hi"),
        ],
      }),
    ]);

    const unsignedCall = parseGateCall(unsignedTx.toXDR());
    assert.equal(unsignedCall.source, source.publicKey());
    assert.equal(unsignedCall.fn, "submit");
    assert.deepEqual(unsignedCall.args, [
      source.publicKey(),
      7,
      100000000000000000000n,
      "hi",
    ]);
    assert.match(unsignedCall.hash, /^[0-9a-f]{64}$/);
    assert.equal(
      unsignedCall.hash,
      Buffer.from(unsignedTx.hash()).toString("hex"),
    );

    const signedTx = buildTx(source, [
      Operation.invokeContractFunction({
        contract: GATE,
        function: "submit",
        args: [
          new Address(source.publicKey()).toScVal(),
          nativeToScVal(7, { type: "u32" }),
          nativeToScVal(100000000000000000000n, { type: "i128" }),
          nativeToScVal("hi"),
        ],
      }),
    ]);
    signedTx.sign(source);

    const signedCall = parseGateCall(signedTx.toXDR());
    assert.equal(signedCall.hash, unsignedCall.hash);
    assert.deepEqual(signedCall.args, unsignedCall.args);
  });
});

describe("assertGateCall", () => {
  const source = Keypair.random();
  const otherAccount = Keypair.random();

  function makeCallXdr(
    fn: string,
    args: any[],
    txSource: Keypair = source,
  ): string {
    const tx = buildTx(txSource, [
      Operation.invokeContractFunction({
        contract: GATE,
        function: fn,
        args,
      }),
    ]);
    return tx.toXDR();
  }

  it('rejects function not in fns with 400 "this endpoint relays submit / challenge only, not finalize"', () => {
    const xdr = makeCallXdr("finalize", [
      new Address(source.publicKey()).toScVal(),
    ]);
    expectHttpError(
      () =>
        assertGateCall(xdr, {
          account: source.publicKey(),
          fns: ["submit", "challenge"],
        }),
      400,
      "this endpoint relays submit / challenge only, not finalize",
    );
  });

  it("checks function before account when both function and account are wrong", () => {
    const xdr = makeCallXdr(
      "finalize",
      [new Address(otherAccount.publicKey()).toScVal()],
      otherAccount,
    );
    expectHttpError(
      () =>
        assertGateCall(xdr, {
          account: source.publicKey(),
          fns: ["submit", "challenge"],
        }),
      400,
      "this endpoint relays submit / challenge only, not finalize",
    );
  });

  it('rejects when transaction source is another account with 403 "transaction must be sent by, and act for, the authenticated account"', () => {
    const xdr = makeCallXdr(
      "submit",
      [new Address(source.publicKey()).toScVal()],
      otherAccount,
    );
    expectHttpError(
      () =>
        assertGateCall(xdr, {
          account: source.publicKey(),
          fns: ["submit"],
        }),
      403,
      "transaction must be sent by, and act for, the authenticated account",
    );
  });

  it('rejects when first argument is another account with 403 "transaction must be sent by, and act for, the authenticated account"', () => {
    const xdr = makeCallXdr("submit", [
      new Address(otherAccount.publicKey()).toScVal(),
    ]);
    expectHttpError(
      () =>
        assertGateCall(xdr, {
          account: source.publicKey(),
          fns: ["submit"],
        }),
      403,
      "transaction must be sent by, and act for, the authenticated account",
    );
  });

  it('rejects when no arguments are passed with 403 "transaction must be sent by, and act for, the authenticated account"', () => {
    const xdr = makeCallXdr("submit", []);
    expectHttpError(
      () =>
        assertGateCall(xdr, {
          account: source.publicKey(),
          fns: ["submit"],
        }),
      403,
      "transaction must be sent by, and act for, the authenticated account",
    );
  });

  it('rejects when first argument is a string (not an address) with 403 "transaction must be sent by, and act for, the authenticated account"', () => {
    const xdr = makeCallXdr("submit", [nativeToScVal("not-an-address")]);
    expectHttpError(
      () =>
        assertGateCall(xdr, {
          account: source.publicKey(),
          fns: ["submit"],
        }),
      403,
      "transaction must be sent by, and act for, the authenticated account",
    );
  });

  it('rejects when check returns a message with 400 "no sevens"', () => {
    const xdr = makeCallXdr("submit", [
      new Address(source.publicKey()).toScVal(),
      nativeToScVal(7, { type: "u32" }),
    ]);
    expectHttpError(
      () =>
        assertGateCall(xdr, {
          account: source.publicKey(),
          fns: ["submit"],
          check: (call) => (call.args[1] === 7 ? "no sevens" : null),
        }),
      400,
      "no sevens",
    );
  });

  it("returns decoded call when check returns null", () => {
    const xdr = makeCallXdr("submit", [
      new Address(source.publicKey()).toScVal(),
      nativeToScVal(8, { type: "u32" }),
    ]);
    let checkCalledWith: unknown = null;
    const res = assertGateCall(xdr, {
      account: source.publicKey(),
      fns: ["submit"],
      check: (call) => {
        checkCalledWith = call;
        return null;
      },
    });
    assert.equal(res.fn, "submit");
    assert.equal(checkCalledWith, res);
  });

  it("does not run check after an earlier rejection", () => {
    const xdr = makeCallXdr("finalize", [
      new Address(source.publicKey()).toScVal(),
    ]);
    let checkCalled = false;
    expectHttpError(
      () =>
        assertGateCall(xdr, {
          account: source.publicKey(),
          fns: ["submit"],
          check: () => {
            checkCalled = true;
            return null;
          },
        }),
      400,
      "this endpoint relays submit only, not finalize",
    );
    assert.equal(checkCalled, false);
  });

  it("allows check to compare a u64 bigint argument to a BigInt id", () => {
    const expectedSubmissionId = 42n;
    const xdr = makeCallXdr("challenge", [
      new Address(source.publicKey()).toScVal(),
      nativeToScVal(42n, { type: "u64" }),
    ]);
    const res = assertGateCall(xdr, {
      account: source.publicKey(),
      fns: ["challenge"],
      check: (call) => {
        const id = call.args[1];
        if (typeof id !== "bigint" || id !== expectedSubmissionId) {
          return "id mismatch";
        }
        return null;
      },
    });
    assert.equal(res.fn, "challenge");
    assert.equal(res.args[1], 42n);
  });
});

describe("assertSimulated", () => {
  it("accepts a successful simulation", () => {
    const assembled = {
      simulation: {
        transactionData: {} as any,
        minResourceFee: "100",
        events: [],
        results: [],
      } as any,
    };
    assert.doesNotThrow(() => assertSimulated(assembled));
  });

  it("throws 422 if simulation is missing", () => {
    expectHttpError(
      () => assertSimulated({} as any),
      422,
      "simulation missing from assembled transaction"
    );
  });

  it("throws contract error when simulation fails with contract error code", () => {
    const assembled = {
      simulation: {
        error: "HostError: Error(Contract, #11)",
      } as any,
    };
    assert.throws(
      () => assertSimulated(assembled),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.equal(contractErrorName(e), "BondTooLow");
        return true;
      }
    );
  });

  it("throws HttpError 422 for non-contract simulation error", () => {
    const assembled = {
      simulation: {
        error: "HostError: Error(Budget, ExceededLimit)",
      } as any,
    };
    expectHttpError(
      () => assertSimulated(assembled),
      422,
      "simulation failed: HostError: Error(Budget, ExceededLimit)"
    );
  });

  it("throws HttpError 409 when simulation reports restore needed", () => {
    const assembled = {
      simulation: {
        transactionData: {} as any,
        restorePreamble: {
          transactionData: {} as any,
          minResourceFee: "100",
        },
      } as any,
    };
    expectHttpError(
      () => assertSimulated(assembled),
      409,
      "contract state expired and needs restoring"
    );
  });
});

describe("buildWithAccountCheck", () => {
  it("returns function result on success", async () => {
    const result = await buildWithAccountCheck(async () => 123);
    assert.equal(result, 123);
  });

  it("maps Account not found to HttpError 400 with helpful message", async () => {
    const account = "GBZXN7PIRZGNMHGA72W2M2UMQLF5RHYU3D3B3PFFXGG3QFF4TGG6A62V";
    await assert.rejects(
      () =>
        buildWithAccountCheck(async () => {
          throw new Error(`Account not found: ${account}`);
        }),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.statusCode, 400);
        assert.equal(
          err.message,
          `account ${account} does not exist on this network; fund it first`
        );
        return true;
      }
    );
  });

  it("rethrows other errors unchanged", async () => {
    await assert.rejects(
      () =>
        buildWithAccountCheck(async () => {
          throw new Error("unrelated error");
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).message, "unrelated error");
        return true;
      }
    );
  });
});
