import { Address, FeeBumpTransaction, rpc, scValToNative, TransactionBuilder } from "@stellar/stellar-sdk";
import { env } from "../config/env.js";
import { HttpError } from "../http-error.js";
import { contractErrorName } from "./actions.js";

export const server = new rpc.Server(env.SOROBAN_RPC_URL);

export interface GateCall {
  /** Account that pays for and authorises the transaction. */
  source: string;
  fn: string;
  args: unknown[];
  /** Hex transaction hash. It does not cover signatures, so it is the same
   * for the unsigned transaction this backend built and the signed one. */
  hash: string;
}

/** Decodes a transaction and requires it to be exactly one EscrowGate
 * contract call. The relay endpoints forward what a wallet signed; without
 * this they would forward any transaction at all on the caller's behalf. */
export function parseGateCall(signedXdr: string): GateCall {
  let tx;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, env.NETWORK_PASSPHRASE);
  } catch {
    throw new HttpError(400, "signed_transaction_xdr is not a valid transaction for this network");
  }
  if (tx instanceof FeeBumpTransaction) {
    throw new HttpError(400, "fee-bump transactions are not relayed");
  }
  if (tx.operations.length !== 1 || tx.operations[0].type !== "invokeHostFunction") {
    throw new HttpError(400, "transaction must be a single EscrowGate contract call");
  }
  const op = tx.operations[0];
  if (op.source && op.source !== tx.source) {
    throw new HttpError(400, "operation source must be the transaction source");
  }
  if (op.func.type !== "hostFunctionTypeInvokeContract") {
    throw new HttpError(400, "transaction must be a single EscrowGate contract call");
  }
  const invoke = op.func.invokeContract;
  const contract = Address.fromScAddress(invoke.contractAddress).toString();
  if (contract !== env.ESCROW_GATE_CONTRACT_ID) {
    throw new HttpError(400, "transaction does not call this deployment's EscrowGate contract");
  }
  return {
    source: tx.source,
    fn: invoke.functionName.toString(),
    args: invoke.args.map((a) => scValToNative(a)),
    hash: Buffer.from(tx.hash()).toString("hex"),
  };
}

/** Requires the signed transaction to be one of `fns` on EscrowGate, sent by
 * `account` and acting for `account` (every user-facing entrypoint takes the
 * acting address as its first argument). */
export function assertGateCall(
  signedXdr: string,
  expected: { account: string; fns: string[]; check?: (call: GateCall) => string | null }
): GateCall {
  const call = parseGateCall(signedXdr);
  if (!expected.fns.includes(call.fn)) {
    throw new HttpError(400, `this endpoint relays ${expected.fns.join(" / ")} only, not ${call.fn}`);
  }
  if (call.source !== expected.account || call.args[0] !== expected.account) {
    throw new HttpError(403, "transaction must be sent by, and act for, the authenticated account");
  }
  const problem = expected.check?.(call) ?? null;
  if (problem) throw new HttpError(400, problem);
  return call;
}

export async function relaySignedXdr(
  signedXdr: string
): Promise<{ hash: string; status: "SUCCESS"; returnValue: unknown }> {
  const tx = TransactionBuilder.fromXDR(signedXdr, env.NETWORK_PASSPHRASE);
  const sendResult = await server.sendTransaction(tx);
  if (sendResult.status === "ERROR") {
    const code = sendResult.errorResult?.result.type ?? "unknown";
    throw new HttpError(422, `The network rejected the transaction (${code}).`);
  }
  if (sendResult.status === "TRY_AGAIN_LATER") {
    throw new HttpError(503, "The network did not accept the transaction right now; nothing was submitted. Sign and relay it again in a moment.");
  }
  const hash = sendResult.hash;
  const deadline = Date.now() + 45_000;
  // PENDING and DUPLICATE both mean this hash is (or already was) in flight,
  // so both fall through to polling for the result.
  let lastPollError: unknown;
  while (Date.now() < deadline) {
    let got;
    try {
      got = await server.getTransaction(hash);
    } catch (err) {
      // A transient RPC failure must not abort the wait: the transaction was
      // accepted and may confirm on the next poll.
      lastPollError = err;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (got.status === "SUCCESS") {
      const returnValue = got.returnValue ? scValToNative(got.returnValue) : null;
      return { hash, status: "SUCCESS", returnValue };
    }
    if (got.status === "FAILED") {
      throw new HttpError(422, `Transaction ${hash} was included but failed on-chain.`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (lastPollError !== undefined) {
    console.error(`polling transaction ${hash} failed:`, lastPollError);
  }
  throw new HttpError(504, `Timed out waiting for transaction ${hash} to confirm. It may still land; check before retrying.`);
}

/** Asserts that an assembled contract transaction's simulation succeeded before
 * creating drafts or storing rows in the database.
 * Throws an Error with contract message (for app.ts to map to 422 with contract_error),
 * HttpError 409 if state needs restoring, or HttpError 422 for other simulation errors. */
export function assertSimulated(assembled: { simulation?: rpc.Api.SimulateTransactionResponse }): void {
  if (!assembled.simulation) {
    throw new HttpError(422, "simulation missing from assembled transaction");
  }
  const sim = assembled.simulation;
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new HttpError(409, "contract state expired and needs restoring");
  }
  if (rpc.Api.isSimulationError(sim)) {
    const errorStr = sim.error || "unknown simulation error";
    if (contractErrorName(errorStr)) {
      throw new Error(errorStr);
    }
    throw new HttpError(422, `simulation failed: ${errorStr}`);
  }
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new HttpError(422, "simulation was not successful");
  }
}

/** Executes a transaction build and maps unfunded account errors (Account not found: G...)
 * to a friendly 400 Bad Request instead of an unhandled 500. */
export async function buildWithAccountCheck<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = /Account not found:\s*(G[A-Z0-9]{55})/.exec(msg);
    if (m) {
      throw new HttpError(400, `account ${m[1]} does not exist on this network; fund it first`);
    }
    throw err;
  }
}
