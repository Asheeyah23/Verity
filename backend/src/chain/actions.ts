import type { SubmissionRecord } from "escrow-gate";
import { Errors } from "escrow-gate";
import { env } from "../config/env.js";
import { escrowGateAsKeeper } from "./clients.js";
import { withKeeperLock } from "./keeper.js";
import { fromChainVerdict } from "./mappers.js";

function isTransactionStillPending(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name;
  if (name === "TransactionStillPendingError" || name === "TransactionStillPending") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("TransactionStillPending") || msg.includes("for transaction to complete, but it did not");
}

async function signAndSendKeeperTx<T>(tx: any): Promise<T> {
  try {
    return await tx.signAndSend();
  } catch (err) {
    if (isTransactionStillPending(err)) {
      const hash =
        (typeof tx.signed?.hash === "function" ? tx.signed.hash().toString("hex") : null) ??
        tx.sendTransactionResponse?.hash ??
        (/"hash":\s*"([0-9a-fA-F]{64})"/.exec(err instanceof Error ? err.message : "")?.[1] ?? "unknown");
      console.error(`[keeper] transaction still pending after ${env.KEEPER_TX_TIMEOUT_S}s: txHash=${hash}`);
    }
    throw err;
  }
}

/** Maps "Error(Contract, #11)" in an SDK/RPC error message back to the
 * contract's own error name (BondTooLow), or null if it isn't one. */
export function contractErrorName(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  if (!m) return null;
  const entry = (Errors as Record<number, { message: string }>)[Number(m[1])];
  return entry?.message ?? `ContractError#${m[1]}`;
}

export async function readSubmission(chainSubmissionId: string): Promise<SubmissionRecord | null> {
  const tx = await escrowGateAsKeeper.get_submission({ id: BigInt(chainSubmissionId) });
  return tx.result ?? null;
}

/** Same arithmetic as the contract's consensus_outcome(): a minimum voter
 * count AND a bonded supermajority in one direction. Used only to decide
 * whether sending a keeper transaction is worthwhile — the contract
 * re-derives the verdict itself and is the sole authority on it. */
export function consensusOutcome(record: SubmissionRecord): "verified" | "slashed" | null {
  const totalVotes = record.match_votes + record.mismatch_votes;
  if (totalVotes < record.cfg_quorum_min_reexecutors) return null;
  const totalWeight = record.bonded_weight_matched + record.bonded_weight_mismatched;
  if (totalWeight <= 0n) return null;
  const rhs = totalWeight * BigInt(record.cfg_quorum_supermajority_bps);
  if (record.bonded_weight_matched * 10000n >= rhs) return "verified";
  if (record.bonded_weight_mismatched * 10000n >= rhs) return "slashed";
  return null;
}

/** The challenger bond floor the contract will enforce for this submission:
 * the bps snapshotted at submit() time, applied to its escrow value. */
export function minChallengerBond(record: SubmissionRecord): bigint {
  return (record.escrow_value * BigInt(record.cfg_challenger_bond_min_bps)) / 10000n;
}

export interface KeeperTxResult {
  status: string;
  txHash: string | null;
}

/** finalize() legitimately has nothing to do in several states — already
 * finalized, or still Pending behind an unresolved challenge that landed a
 * ledger after consensus formed. Simulation then reports a pure read, which
 * the SDK refuses to sign and send; the simulated verdict is the answer. */
export function finalizeOnChain(chainSubmissionId: string): Promise<KeeperTxResult> {
  return withKeeperLock(async () => {
    const tx = await escrowGateAsKeeper.finalize(
      { submission_id: BigInt(chainSubmissionId) },
      { timeoutInSeconds: env.KEEPER_TX_TIMEOUT_S }
    );
    if (tx.isReadCall) {
      return { status: fromChainVerdict(tx.result.unwrap()), txHash: null };
    }
    const sent = await signAndSendKeeperTx<any>(tx);
    return {
      status: fromChainVerdict(sent.result.unwrap()),
      txHash: sent.sendTransactionResponse?.hash ?? null,
    };
  });
}

export function resolveChallengeOnChain(chainSubmissionId: string): Promise<KeeperTxResult> {
  return withKeeperLock(async () => {
    const tx = await escrowGateAsKeeper.resolve_challenge(
      {
        submission_id: BigInt(chainSubmissionId),
        // The only method the contract accepts in Phase 1.
        method: { tag: "ReexecutionConsensus", values: void 0 },
      },
      { timeoutInSeconds: env.KEEPER_TX_TIMEOUT_S }
    );
    const sent = await signAndSendKeeperTx<any>(tx);
    return {
      status: fromChainVerdict(sent.result.unwrap()),
      txHash: sent.sendTransactionResponse?.hash ?? null,
    };
  });
}

/** Releases a voter's stake lock on a finalized submission. The contract
 * slashes a vote the consensus proved wrong in this same call, before the
 * lock comes off — whether and how much is decided entirely on-chain, so
 * there is no separate slash step and nothing for this caller to choose.
 * Returns the transaction hash, or null if the lock was already released. */
export function releaseAttestationLockOnChain(chainSubmissionId: string, reexecutor: string): Promise<string | null> {
  return withKeeperLock(async () => {
    try {
      const tx = await escrowGateAsKeeper.release_attestation_lock(
        {
          submission_id: BigInt(chainSubmissionId),
          reexecutor,
        },
        { timeoutInSeconds: env.KEEPER_TX_TIMEOUT_S }
      );
      const sent = await signAndSendKeeperTx<any>(tx);
      sent.result.unwrap();
      return sent.sendTransactionResponse?.hash ?? null;
    } catch (err) {
      if (contractErrorName(err) === "AttestationAlreadyReleased") return null;
      throw err;
    }
  });
}
