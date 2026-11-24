import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}













export type DataKey = {tag: "Admin", values: void} | {tag: "BondAsset", values: void} | {tag: "Config", values: void} | {tag: "NextSubmissionId", values: void} | {tag: "Submission", values: readonly [u64]} | {tag: "ReplayAttestation", values: readonly [u64, string]} | {tag: "Challenge", values: readonly [u64]} | {tag: "Reexecutor", values: readonly [string]} | {tag: "Slashed", values: readonly [u64, string]} | {tag: "AttestationReleased", values: readonly [u64, string]};

export type Verdict = {tag: "Pending", values: void} | {tag: "Verified", values: void} | {tag: "Disputed", values: void} | {tag: "Slashed", values: void} | {tag: "ExpiredUnverified", values: void};

/**
 * The shape of task a submission claims to have completed.
 * `Unverifiable` is reserved: `EscrowGate::submit` rejects it with
 * `Error::InvalidTaskType`, so no submission can carry it today.
 */
export type TaskType = {tag: "Deterministic", values: void} | {tag: "Retrieval", values: void} | {tag: "Unverifiable", values: void};

export type Resolution = {tag: "None", values: void} | {tag: "Upheld", values: void} | {tag: "Rejected", values: void};


export interface ConfigRecord {
  /**
 * Minimum agent bond as bps of escrow_value, e.g. 500 = 5%.
 */
agent_bond_min_bps: u32;
  /**
 * Minimum challenger bond as bps of escrow_value.
 */
challenger_bond_min_bps: u32;
  min_stake_floor: i128;
  quorum_min_reexecutors: u32;
  /**
 * Basis points, must be in [5100, 10000] — bounds enforced at update_config time.
 */
quorum_supermajority_bps: u32;
  /**
 * When true, only re-executors the admin has approved may attest. Meant
 * for networks where stake is free (testnet), where an open voter set
 * can be captured at no cost.
 */
reexecutor_allowlist: boolean;
  /**
 * Share of a wrong-side re-executor's stake forfeited when a bonded
 * consensus proves their vote wrong. Set on-chain so the amount is never
 * a caller's choice; 0 disables re-executor slashing.
 */
reexecutor_slash_bps: u32;
  /**
 * Share of a slashed amount that goes to the prevailing challenger; the
 * remainder goes to the admin/treasury account. Fixed in practice —
 * treated as effectively immutable governance, not a per-dispute lever.
 */
slash_split_challenger_bps: u32;
  window_tier_large_s: u64;
  /**
 * escrow_value strictly below this uses the "small" window tier.
 */
window_tier_small_ceiling: i128;
  window_tier_small_s: u64;
}


export interface ReexecutorInfo {
  active: boolean;
  /**
 * Set by the admin through EscrowGate::set_reexecutor_approved. Only
 * consulted while ConfigRecord::reexecutor_allowlist is on.
 */
approved: boolean;
  joined_at: u64;
  /**
 * Count of attestations this reexecutor has made on submissions that are
 * not yet finalized/resolved. Stake cannot be withdrawn below
 * min_stake_floor while this is nonzero — see EscrowGate::withdraw_stake
 * and EscrowGate::release_attestation_lock.
 */
open_attestations: u32;
  stake_amount: i128;
}


export interface ChallengeRecord {
  bond: i128;
  challenger: string;
  opened_at: u64;
  resolution: Resolution;
  resolution_method: ResolutionMethod;
}

/**
 * `ManualReview` is deliberately NOT a variant here. On-chain resolution must be
 * derivable from already-committed state (attestation tallies or a registered
 * ZK verifier's boolean result) with zero admin-discretionary paths. A
 * challenge that cannot be resolved expires on-chain as `ExpiredUnverified`.
 * 
 * `None` (rather than wrapping this in `Option<ResolutionMethod>` on the
 * containing structs) is a deliberate soroban-sdk contracttype workaround:
 * `Option<CustomEnum>` fields fail to derive their ScVal conversion in
 * soroban-sdk 27's #[contracttype] macro for simple (data-less) enums, so a
 * dedicated `None` variant is used as the "not yet set" sentinel instead.
 * 
 * `WindowElapsed` marks a verdict nobody actually established: the window
 * closed without a bonded consensus. It is kept distinct from
 * `ReexecutionConsensus` so a submission that was never replayed to quorum
 * can never be presented as one that was, and so nobody is slashed for it.
 * 
 * `ZkProof` is reserved for Phase 2. No entrypoint accepts it today.
 */
export type ResolutionMethod = {tag: "None", values: void} | {tag: "ReexecutionConsensus", values: void} | {tag: "ZkProof", values: void} | {tag: "WindowElapsed", values: void};


export interface SubmissionRecord {
  agent: string;
  bond_amount: i128;
  bonded_weight_matched: i128;
  bonded_weight_mismatched: i128;
  cfg_challenger_bond_min_bps: u32;
  cfg_quorum_min_reexecutors: u32;
  cfg_quorum_supermajority_bps: u32;
  cfg_reexecutor_slash_bps: u32;
  cfg_slash_split_challenger_bps: u32;
  challenge_window_s: u64;
  claimed_output_hash: Buffer;
  escrow_ref: Buffer;
  escrow_value: i128;
  finalized: boolean;
  id: u64;
  input_hash: Buffer;
  match_votes: u32;
  mismatch_votes: u32;
  resolution_method: ResolutionMethod;
  submitted_at: u64;
  task_type: TaskType;
  verdict: Verdict;
}

export const Errors = {
  1: {message:"AlreadyInitialized"},
  2: {message:"NotInitialized"},
  3: {message:"NotAdmin"},
  4: {message:"InvalidConfig"},
  5: {message:"Overflow"},
  6: {message:"InvalidAmount"},
  10: {message:"SubmissionNotFound"},
  11: {message:"BondTooLow"},
  12: {message:"InvalidTaskType"},
  13: {message:"InvalidEscrowValue"},
  14: {message:"InvalidOutputHash"},
  20: {message:"ReexecutorNotActive"},
  21: {message:"StakeBelowFloor"},
  22: {message:"StakeLockedByOpenAttestation"},
  23: {message:"AlreadyAttested"},
  24: {message:"ReexecutorAlreadyRegistered"},
  25: {message:"AttestationAlreadyReleased"},
  26: {message:"SubmissionNotFinalized"},
  27: {message:"ReexecutorNotApproved"},
  28: {message:"VoteContradictsHash"},
  29: {message:"AgentCannotAttest"},
  30: {message:"ChallengeAlreadyOpen"},
  31: {message:"ChallengeNotFound"},
  32: {message:"ChallengeWindowClosed"},
  33: {message:"ChallengeWindowNotElapsed"},
  34: {message:"NoUnresolvedChallenge"},
  35: {message:"ChallengeAlreadyResolved"},
  36: {message:"AgentCannotChallenge"},
  37: {message:"ConsensusAlreadyReached"},
  40: {message:"NotUpheldResolution"},
  41: {message:"AlreadySlashed"},
  42: {message:"PartyNotOnWrongSide"},
  44: {message:"InsufficientConsensus"},
  45: {message:"InvalidResolutionMethod"},
  46: {message:"NotSlashable"},
  50: {message:"VerifierNotRegistered"},
  51: {message:"VerifierAlreadyRegistered"},
  52: {message:"ProofRejected"}
}

export interface Client {
  /**
   * Construct and simulate a slash transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless, and the caller chooses nothing: every check derives
   * from already-committed on-chain state, and the amount is the
   * cfg_reexecutor_slash_bps share snapshotted at submit() time. The
   * submission must have been finalized by a bonded consensus — a verdict
   * that merely defaulted when the window elapsed proves nobody wrong — and
   * the target's own recorded vote (stored at attest_replay time) must be
   * on the side that consensus proved wrong. There is no branch here, or
   * anywhere in this contract, where the admin's address changes the
   * outcome (invariant 2).
   * 
   * release_attestation_lock() applies the same slash on its own, so this
   * entrypoint is never required — it only lets anyone slash sooner.
   */
  slash: ({reexecutor, submission_id}: {reexecutor: string, submission_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a submit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  submit: ({agent, escrow_ref, escrow_value, task_type, input_hash, output_hash, bond}: {agent: string, escrow_ref: Buffer, escrow_value: i128, task_type: TaskType, input_hash: Buffer, output_hash: Buffer, bond: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a finalize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The sole writer of terminal submission state and the sole mover of the
   * agent's bond. Idempotent: a repeat call after finalized=true is a pure
   * read with zero storage writes and zero token transfers (invariant 3).
   * Only ever auto-verifies before the window closes when a bonded
   * consensus majority already exists and no challenge is open
   * (invariant 1).
   * 
   * Absent both a challenge and a consensus, a window-elapsed submission
   * defaults to Verified per the PRD's optimistic-verification design (no
   * challenge => no proof of fraud) — unless a re-executor reported a
   * mismatch, in which case the work was contested without being settled
   * and it expires as ExpiredUnverified instead. Either way the verdict is
   * recorded as WindowElapsed, never as a consensus that did not happen.
   * 
   * A challenge that nobody can resolve — re-executors never reached a
   * bonded consensus within one further challenge window of it being
   * opened — expires as ExpiredUnverified and releases both bonds, rather
   * than freezing the agent's and challenger's funds fo
   */
  finalize: ({submission_id}: {submission_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Verdict>>>

  /**
   * Construct and simulate a get_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a get_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_config: (options?: MethodOptions) => Promise<AssembledTransaction<Option<ConfigRecord>>>

  /**
   * Construct and simulate a attest_replay transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Any account with sufficient active stake may attest on any submission
   * (off-chain assignment/scheduling is the backend's job, not an on-chain
   * gate) — unless ConfigRecord::reexecutor_allowlist is on, in which case
   * the admin must also have approved the account. One vote per
   * (submission, reexecutor), enforced by the ReplayAttestation storage
   * guard. Records the raw output hash alongside the vote for later
   * off-chain audit; the contract itself only trusts the boolean `matched`
   * claim plus bonded-majority economics.
   */
  attest_replay: ({reexecutor, submission_id, output_hash, matched}: {reexecutor: string, submission_id: u64, output_hash: Buffer, matched: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_challenge transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_challenge: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<ChallengeRecord>>>

  /**
   * Construct and simulate a update_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-gated, additive capability change only (which knobs future
   * submissions use) — never a per-submission or per-dispute override.
   * Every SubmissionRecord snapshots the config values that govern it at
   * submit() time, so this can never retroactively change an in-flight
   * submission's rules.
   */
  update_config: ({admin, config}: {admin: string, config: ConfigRecord}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a get_submission transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  get_submission: ({id}: {id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<SubmissionRecord>>>

  /**
   * Construct and simulate a open_challenge transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Bond-proportional, snapshotted at submit() time (invariant 5).
   */
  open_challenge: ({challenger, submission_id, bond}: {challenger: string, submission_id: u64, bond: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a withdraw_stake transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Blocked entirely while any of this reexecutor's attestations sit on a
   * not-yet-finalized submission — see release_attestation_lock. A vote is
   * weighted by the full stake at the moment it is cast, but a slash takes a
   * share of the stake at slash time, so any stake allowed to leave before
   * then would be weight that was never at risk. A reexecutor with zero
   * open attestations may withdraw in full, deactivating themselves.
   */
  withdraw_stake: ({reexecutor, amount}: {reexecutor: string, amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a reexecutor_info transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  reexecutor_info: ({reexecutor}: {reexecutor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<ReexecutorInfo>>>

  /**
   * Construct and simulate a resolve_challenge transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Permissionless — every precondition is read from already-committed
   * on-chain state (the bonded attestation tally), never from caller
   * identity (invariant 2). Delegates the actual verdict-setting and fund
   * movement to finalize(), which is the single idempotent writer of
   * terminal state (invariant 3).
   * 
   * Re-execution consensus is the only way to resolve a challenge in
   * Phase 1. `ZkProof` is rejected outright: this entrypoint carries no
   * proof, so honouring it would mean taking a registry's word for a proof
   * nobody supplied — and whoever administers that registry could then
   * decide any challenge (invariant 4).
   */
  resolve_challenge: ({submission_id, method}: {submission_id: u64, method: ResolutionMethod}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Verdict>>>

  /**
   * Construct and simulate a register_reexecutor transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Also serves as a stake top-up for an already-registered reexecutor.
   */
  register_reexecutor: ({reexecutor, stake_amount}: {reexecutor: string, stake_amount: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_reexecutor_approved transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin-gated membership of the voter set, consulted by attest_replay
   * while ConfigRecord::reexecutor_allowlist is on. This is a real admin
   * power: the admin decides who may vote. It exists because bonded
   * consensus is only as strong as the cost of the bond, and on a network
   * where stake is free an open voter set can be captured for nothing.
   * It never decides an individual verdict — every verdict still comes
   * from the votes the approved set casts.
   */
  set_reexecutor_approved: ({admin, reexecutor, approved}: {admin: string, reexecutor: string, approved: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a release_attestation_lock transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Attester with zero open (unresolved) attestations already withdraws
   * freely; this permissionless bookkeeping call unlocks the counter once
   * a given submission this reexecutor voted on has been finalized, without
   * requiring the contract to enumerate all of a submission's attesters.
   * 
   * A vote the verdict proved wrong is slashed here, before the lock comes
   * off. The lock is the only thing keeping that stake in the contract, so
   * releasing it first would let the voter withdraw ahead of the slash.
   */
  release_attestation_lock: ({submission_id, reexecutor}: {submission_id: u64, reexecutor: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, bond_asset, config}: {admin: string, bond_asset: string, config: ConfigRecord},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, bond_asset, config}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAsBQZXJtaXNzaW9ubGVzcywgYW5kIHRoZSBjYWxsZXIgY2hvb3NlcyBub3RoaW5nOiBldmVyeSBjaGVjayBkZXJpdmVzCmZyb20gYWxyZWFkeS1jb21taXR0ZWQgb24tY2hhaW4gc3RhdGUsIGFuZCB0aGUgYW1vdW50IGlzIHRoZQpjZmdfcmVleGVjdXRvcl9zbGFzaF9icHMgc2hhcmUgc25hcHNob3R0ZWQgYXQgc3VibWl0KCkgdGltZS4gVGhlCnN1Ym1pc3Npb24gbXVzdCBoYXZlIGJlZW4gZmluYWxpemVkIGJ5IGEgYm9uZGVkIGNvbnNlbnN1cyDigJQgYSB2ZXJkaWN0CnRoYXQgbWVyZWx5IGRlZmF1bHRlZCB3aGVuIHRoZSB3aW5kb3cgZWxhcHNlZCBwcm92ZXMgbm9ib2R5IHdyb25nIOKAlCBhbmQKdGhlIHRhcmdldCdzIG93biByZWNvcmRlZCB2b3RlIChzdG9yZWQgYXQgYXR0ZXN0X3JlcGxheSB0aW1lKSBtdXN0IGJlCm9uIHRoZSBzaWRlIHRoYXQgY29uc2Vuc3VzIHByb3ZlZCB3cm9uZy4gVGhlcmUgaXMgbm8gYnJhbmNoIGhlcmUsIG9yCmFueXdoZXJlIGluIHRoaXMgY29udHJhY3QsIHdoZXJlIHRoZSBhZG1pbidzIGFkZHJlc3MgY2hhbmdlcyB0aGUKb3V0Y29tZSAoaW52YXJpYW50IDIpLgoKcmVsZWFzZV9hdHRlc3RhdGlvbl9sb2NrKCkgYXBwbGllcyB0aGUgc2FtZSBzbGFzaCBvbiBpdHMgb3duLCBzbyB0aGlzCmVudHJ5cG9pbnQgaXMgbmV2ZXIgcmVxdWlyZWQg4oCUIGl0IG9ubHkgbGV0cyBhbnlvbmUgc2xhc2ggc29vbmVyLgAAAAVzbGFzaAAAAAAAAAIAAAAAAAAACnJlZXhlY3V0b3IAAAAAABMAAAAAAAAADXN1Ym1pc3Npb25faWQAAAAAAAAGAAAAAQAAA+kAAAALAAAAAw==",
        "AAAAAAAAAAAAAAAGc3VibWl0AAAAAAAHAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAACmVzY3Jvd19yZWYAAAAAA+4AAAAgAAAAAAAAAAxlc2Nyb3dfdmFsdWUAAAALAAAAAAAAAAl0YXNrX3R5cGUAAAAAAAfQAAAACFRhc2tUeXBlAAAAAAAAAAppbnB1dF9oYXNoAAAAAAPuAAAAIAAAAAAAAAALb3V0cHV0X2hhc2gAAAAD7gAAACAAAAAAAAAABGJvbmQAAAALAAAAAQAAA+kAAAAGAAAAAw==",
        "AAAAAAAABABUaGUgc29sZSB3cml0ZXIgb2YgdGVybWluYWwgc3VibWlzc2lvbiBzdGF0ZSBhbmQgdGhlIHNvbGUgbW92ZXIgb2YgdGhlCmFnZW50J3MgYm9uZC4gSWRlbXBvdGVudDogYSByZXBlYXQgY2FsbCBhZnRlciBmaW5hbGl6ZWQ9dHJ1ZSBpcyBhIHB1cmUKcmVhZCB3aXRoIHplcm8gc3RvcmFnZSB3cml0ZXMgYW5kIHplcm8gdG9rZW4gdHJhbnNmZXJzIChpbnZhcmlhbnQgMykuCk9ubHkgZXZlciBhdXRvLXZlcmlmaWVzIGJlZm9yZSB0aGUgd2luZG93IGNsb3NlcyB3aGVuIGEgYm9uZGVkCmNvbnNlbnN1cyBtYWpvcml0eSBhbHJlYWR5IGV4aXN0cyBhbmQgbm8gY2hhbGxlbmdlIGlzIG9wZW4KKGludmFyaWFudCAxKS4KCkFic2VudCBib3RoIGEgY2hhbGxlbmdlIGFuZCBhIGNvbnNlbnN1cywgYSB3aW5kb3ctZWxhcHNlZCBzdWJtaXNzaW9uCmRlZmF1bHRzIHRvIFZlcmlmaWVkIHBlciB0aGUgUFJEJ3Mgb3B0aW1pc3RpYy12ZXJpZmljYXRpb24gZGVzaWduIChubwpjaGFsbGVuZ2UgPT4gbm8gcHJvb2Ygb2YgZnJhdWQpIOKAlCB1bmxlc3MgYSByZS1leGVjdXRvciByZXBvcnRlZCBhCm1pc21hdGNoLCBpbiB3aGljaCBjYXNlIHRoZSB3b3JrIHdhcyBjb250ZXN0ZWQgd2l0aG91dCBiZWluZyBzZXR0bGVkCmFuZCBpdCBleHBpcmVzIGFzIEV4cGlyZWRVbnZlcmlmaWVkIGluc3RlYWQuIEVpdGhlciB3YXkgdGhlIHZlcmRpY3QgaXMKcmVjb3JkZWQgYXMgV2luZG93RWxhcHNlZCwgbmV2ZXIgYXMgYSBjb25zZW5zdXMgdGhhdCBkaWQgbm90IGhhcHBlbi4KCkEgY2hhbGxlbmdlIHRoYXQgbm9ib2R5IGNhbiByZXNvbHZlIOKAlCByZS1leGVjdXRvcnMgbmV2ZXIgcmVhY2hlZCBhCmJvbmRlZCBjb25zZW5zdXMgd2l0aGluIG9uZSBmdXJ0aGVyIGNoYWxsZW5nZSB3aW5kb3cgb2YgaXQgYmVpbmcKb3BlbmVkIOKAlCBleHBpcmVzIGFzIEV4cGlyZWRVbnZlcmlmaWVkIGFuZCByZWxlYXNlcyBib3RoIGJvbmRzLCByYXRoZXIKdGhhbiBmcmVlemluZyB0aGUgYWdlbnQncyBhbmQgY2hhbGxlbmdlcidzIGZ1bmRzIGZvAAAACGZpbmFsaXplAAAAAQAAAAAAAAANc3VibWlzc2lvbl9pZAAAAAAAAAYAAAABAAAD6QAAB9AAAAAHVmVyZGljdAAAAAAD",
        "AAAAAAAAAAAAAAAJZ2V0X2FkbWluAAAAAAAAAAAAAAEAAAPoAAAAEw==",
        "AAAAAAAAAAAAAAAKZ2V0X2NvbmZpZwAAAAAAAAAAAAEAAAPoAAAH0AAAAAxDb25maWdSZWNvcmQ=",
        "AAAAAAAAAIBSdW5zIG9uY2UsIGF0b21pY2FsbHkgd2l0aCBkZXBsb3ltZW50LCBzbyB0aGVyZSBpcyBubyB3aW5kb3cgaW4gd2hpY2gKc29tZWJvZHkgb3RoZXIgdGhhbiB0aGUgZGVwbG95ZXIgY2FuIGNsYWltIHRoZSBhZG1pbiByb2xlLgAAAA1fX2NvbnN0cnVjdG9yAAAAAAAAAwAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAAAAAApib25kX2Fzc2V0AAAAAAATAAAAAAAAAAZjb25maWcAAAAAB9AAAAAMQ29uZmlnUmVjb3JkAAAAAA==",
        "AAAAAAAAAgJBbnkgYWNjb3VudCB3aXRoIHN1ZmZpY2llbnQgYWN0aXZlIHN0YWtlIG1heSBhdHRlc3Qgb24gYW55IHN1Ym1pc3Npb24KKG9mZi1jaGFpbiBhc3NpZ25tZW50L3NjaGVkdWxpbmcgaXMgdGhlIGJhY2tlbmQncyBqb2IsIG5vdCBhbiBvbi1jaGFpbgpnYXRlKSDigJQgdW5sZXNzIENvbmZpZ1JlY29yZDo6cmVleGVjdXRvcl9hbGxvd2xpc3QgaXMgb24sIGluIHdoaWNoIGNhc2UKdGhlIGFkbWluIG11c3QgYWxzbyBoYXZlIGFwcHJvdmVkIHRoZSBhY2NvdW50LiBPbmUgdm90ZSBwZXIKKHN1Ym1pc3Npb24sIHJlZXhlY3V0b3IpLCBlbmZvcmNlZCBieSB0aGUgUmVwbGF5QXR0ZXN0YXRpb24gc3RvcmFnZQpndWFyZC4gUmVjb3JkcyB0aGUgcmF3IG91dHB1dCBoYXNoIGFsb25nc2lkZSB0aGUgdm90ZSBmb3IgbGF0ZXIKb2ZmLWNoYWluIGF1ZGl0OyB0aGUgY29udHJhY3QgaXRzZWxmIG9ubHkgdHJ1c3RzIHRoZSBib29sZWFuIGBtYXRjaGVkYApjbGFpbSBwbHVzIGJvbmRlZC1tYWpvcml0eSBlY29ub21pY3MuAAAAAAANYXR0ZXN0X3JlcGxheQAAAAAAAAQAAAAAAAAACnJlZXhlY3V0b3IAAAAAABMAAAAAAAAADXN1Ym1pc3Npb25faWQAAAAAAAAGAAAAAAAAAAtvdXRwdXRfaGFzaAAAAAPuAAAAIAAAAAAAAAAHbWF0Y2hlZAAAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAANZ2V0X2NoYWxsZW5nZQAAAAAAAAEAAAAAAAAAAmlkAAAAAAAGAAAAAQAAA+gAAAfQAAAAD0NoYWxsZW5nZVJlY29yZAA=",
        "AAAAAAAAASFBZG1pbi1nYXRlZCwgYWRkaXRpdmUgY2FwYWJpbGl0eSBjaGFuZ2Ugb25seSAod2hpY2gga25vYnMgZnV0dXJlCnN1Ym1pc3Npb25zIHVzZSkg4oCUIG5ldmVyIGEgcGVyLXN1Ym1pc3Npb24gb3IgcGVyLWRpc3B1dGUgb3ZlcnJpZGUuCkV2ZXJ5IFN1Ym1pc3Npb25SZWNvcmQgc25hcHNob3RzIHRoZSBjb25maWcgdmFsdWVzIHRoYXQgZ292ZXJuIGl0IGF0CnN1Ym1pdCgpIHRpbWUsIHNvIHRoaXMgY2FuIG5ldmVyIHJldHJvYWN0aXZlbHkgY2hhbmdlIGFuIGluLWZsaWdodApzdWJtaXNzaW9uJ3MgcnVsZXMuAAAAAAAADXVwZGF0ZV9jb25maWcAAAAAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAABmNvbmZpZwAAAAAH0AAAAAxDb25maWdSZWNvcmQAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAOZ2V0X3N1Ym1pc3Npb24AAAAAAAEAAAAAAAAAAmlkAAAAAAAGAAAAAQAAA+gAAAfQAAAAEFN1Ym1pc3Npb25SZWNvcmQ=",
        "AAAAAAAAAD5Cb25kLXByb3BvcnRpb25hbCwgc25hcHNob3R0ZWQgYXQgc3VibWl0KCkgdGltZSAoaW52YXJpYW50IDUpLgAAAAAADm9wZW5fY2hhbGxlbmdlAAAAAAADAAAAAAAAAApjaGFsbGVuZ2VyAAAAAAATAAAAAAAAAA1zdWJtaXNzaW9uX2lkAAAAAAAABgAAAAAAAAAEYm9uZAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAaNCbG9ja2VkIGVudGlyZWx5IHdoaWxlIGFueSBvZiB0aGlzIHJlZXhlY3V0b3IncyBhdHRlc3RhdGlvbnMgc2l0IG9uIGEKbm90LXlldC1maW5hbGl6ZWQgc3VibWlzc2lvbiDigJQgc2VlIHJlbGVhc2VfYXR0ZXN0YXRpb25fbG9jay4gQSB2b3RlIGlzCndlaWdodGVkIGJ5IHRoZSBmdWxsIHN0YWtlIGF0IHRoZSBtb21lbnQgaXQgaXMgY2FzdCwgYnV0IGEgc2xhc2ggdGFrZXMgYQpzaGFyZSBvZiB0aGUgc3Rha2UgYXQgc2xhc2ggdGltZSwgc28gYW55IHN0YWtlIGFsbG93ZWQgdG8gbGVhdmUgYmVmb3JlCnRoZW4gd291bGQgYmUgd2VpZ2h0IHRoYXQgd2FzIG5ldmVyIGF0IHJpc2suIEEgcmVleGVjdXRvciB3aXRoIHplcm8Kb3BlbiBhdHRlc3RhdGlvbnMgbWF5IHdpdGhkcmF3IGluIGZ1bGwsIGRlYWN0aXZhdGluZyB0aGVtc2VsdmVzLgAAAAAOd2l0aGRyYXdfc3Rha2UAAAAAAAIAAAAAAAAACnJlZXhlY3V0b3IAAAAAABMAAAAAAAAABmFtb3VudAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAPcmVleGVjdXRvcl9pbmZvAAAAAAEAAAAAAAAACnJlZXhlY3V0b3IAAAAAABMAAAABAAAD6AAAB9AAAAAOUmVleGVjdXRvckluZm8AAA==",
        "AAAAAAAAAmBQZXJtaXNzaW9ubGVzcyDigJQgZXZlcnkgcHJlY29uZGl0aW9uIGlzIHJlYWQgZnJvbSBhbHJlYWR5LWNvbW1pdHRlZApvbi1jaGFpbiBzdGF0ZSAodGhlIGJvbmRlZCBhdHRlc3RhdGlvbiB0YWxseSksIG5ldmVyIGZyb20gY2FsbGVyCmlkZW50aXR5IChpbnZhcmlhbnQgMikuIERlbGVnYXRlcyB0aGUgYWN0dWFsIHZlcmRpY3Qtc2V0dGluZyBhbmQgZnVuZAptb3ZlbWVudCB0byBmaW5hbGl6ZSgpLCB3aGljaCBpcyB0aGUgc2luZ2xlIGlkZW1wb3RlbnQgd3JpdGVyIG9mCnRlcm1pbmFsIHN0YXRlIChpbnZhcmlhbnQgMykuCgpSZS1leGVjdXRpb24gY29uc2Vuc3VzIGlzIHRoZSBvbmx5IHdheSB0byByZXNvbHZlIGEgY2hhbGxlbmdlIGluClBoYXNlIDEuIGBaa1Byb29mYCBpcyByZWplY3RlZCBvdXRyaWdodDogdGhpcyBlbnRyeXBvaW50IGNhcnJpZXMgbm8KcHJvb2YsIHNvIGhvbm91cmluZyBpdCB3b3VsZCBtZWFuIHRha2luZyBhIHJlZ2lzdHJ5J3Mgd29yZCBmb3IgYSBwcm9vZgpub2JvZHkgc3VwcGxpZWQg4oCUIGFuZCB3aG9ldmVyIGFkbWluaXN0ZXJzIHRoYXQgcmVnaXN0cnkgY291bGQgdGhlbgpkZWNpZGUgYW55IGNoYWxsZW5nZSAoaW52YXJpYW50IDQpLgAAABFyZXNvbHZlX2NoYWxsZW5nZQAAAAAAAAIAAAAAAAAADXN1Ym1pc3Npb25faWQAAAAAAAAGAAAAAAAAAAZtZXRob2QAAAAAB9AAAAAQUmVzb2x1dGlvbk1ldGhvZAAAAAEAAAPpAAAH0AAAAAdWZXJkaWN0AAAAAAM=",
        "AAAAAAAAAENBbHNvIHNlcnZlcyBhcyBhIHN0YWtlIHRvcC11cCBmb3IgYW4gYWxyZWFkeS1yZWdpc3RlcmVkIHJlZXhlY3V0b3IuAAAAABNyZWdpc3Rlcl9yZWV4ZWN1dG9yAAAAAAIAAAAAAAAACnJlZXhlY3V0b3IAAAAAABMAAAAAAAAADHN0YWtlX2Ftb3VudAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAb1BZG1pbi1nYXRlZCBtZW1iZXJzaGlwIG9mIHRoZSB2b3RlciBzZXQsIGNvbnN1bHRlZCBieSBhdHRlc3RfcmVwbGF5CndoaWxlIENvbmZpZ1JlY29yZDo6cmVleGVjdXRvcl9hbGxvd2xpc3QgaXMgb24uIFRoaXMgaXMgYSByZWFsIGFkbWluCnBvd2VyOiB0aGUgYWRtaW4gZGVjaWRlcyB3aG8gbWF5IHZvdGUuIEl0IGV4aXN0cyBiZWNhdXNlIGJvbmRlZApjb25zZW5zdXMgaXMgb25seSBhcyBzdHJvbmcgYXMgdGhlIGNvc3Qgb2YgdGhlIGJvbmQsIGFuZCBvbiBhIG5ldHdvcmsKd2hlcmUgc3Rha2UgaXMgZnJlZSBhbiBvcGVuIHZvdGVyIHNldCBjYW4gYmUgY2FwdHVyZWQgZm9yIG5vdGhpbmcuCkl0IG5ldmVyIGRlY2lkZXMgYW4gaW5kaXZpZHVhbCB2ZXJkaWN0IOKAlCBldmVyeSB2ZXJkaWN0IHN0aWxsIGNvbWVzCmZyb20gdGhlIHZvdGVzIHRoZSBhcHByb3ZlZCBzZXQgY2FzdHMuAAAAAAAAF3NldF9yZWV4ZWN1dG9yX2FwcHJvdmVkAAAAAAMAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAKcmVleGVjdXRvcgAAAAAAEwAAAAAAAAAIYXBwcm92ZWQAAAABAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAelBdHRlc3RlciB3aXRoIHplcm8gb3BlbiAodW5yZXNvbHZlZCkgYXR0ZXN0YXRpb25zIGFscmVhZHkgd2l0aGRyYXdzCmZyZWVseTsgdGhpcyBwZXJtaXNzaW9ubGVzcyBib29ra2VlcGluZyBjYWxsIHVubG9ja3MgdGhlIGNvdW50ZXIgb25jZQphIGdpdmVuIHN1Ym1pc3Npb24gdGhpcyByZWV4ZWN1dG9yIHZvdGVkIG9uIGhhcyBiZWVuIGZpbmFsaXplZCwgd2l0aG91dApyZXF1aXJpbmcgdGhlIGNvbnRyYWN0IHRvIGVudW1lcmF0ZSBhbGwgb2YgYSBzdWJtaXNzaW9uJ3MgYXR0ZXN0ZXJzLgoKQSB2b3RlIHRoZSB2ZXJkaWN0IHByb3ZlZCB3cm9uZyBpcyBzbGFzaGVkIGhlcmUsIGJlZm9yZSB0aGUgbG9jayBjb21lcwpvZmYuIFRoZSBsb2NrIGlzIHRoZSBvbmx5IHRoaW5nIGtlZXBpbmcgdGhhdCBzdGFrZSBpbiB0aGUgY29udHJhY3QsIHNvCnJlbGVhc2luZyBpdCBmaXJzdCB3b3VsZCBsZXQgdGhlIHZvdGVyIHdpdGhkcmF3IGFoZWFkIG9mIHRoZSBzbGFzaC4AAAAAAAAYcmVsZWFzZV9hdHRlc3RhdGlvbl9sb2NrAAAAAgAAAAAAAAANc3VibWlzc2lvbl9pZAAAAAAAAAYAAAAAAAAACnJlZXhlY3V0b3IAAAAAABMAAAABAAAD6QAAAAIAAAAD",
        "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",
        "AAAAAgAAAAAAAAAAAAAAB1ZlcmRpY3QAAAAABQAAAAAAAAAAAAAAB1BlbmRpbmcAAAAAAAAAAAAAAAAIVmVyaWZpZWQAAAAAAAAAAAAAAAhEaXNwdXRlZAAAAAAAAAAAAAAAB1NsYXNoZWQAAAAAAAAAAAAAAAARRXhwaXJlZFVudmVyaWZpZWQAAAA=",
        "AAAAAgAAALhUaGUgc2hhcGUgb2YgdGFzayBhIHN1Ym1pc3Npb24gY2xhaW1zIHRvIGhhdmUgY29tcGxldGVkLgpgVW52ZXJpZmlhYmxlYCBpcyByZXNlcnZlZDogYEVzY3Jvd0dhdGU6OnN1Ym1pdGAgcmVqZWN0cyBpdCB3aXRoCmBFcnJvcjo6SW52YWxpZFRhc2tUeXBlYCwgc28gbm8gc3VibWlzc2lvbiBjYW4gY2FycnkgaXQgdG9kYXkuAAAAAAAAAAhUYXNrVHlwZQAAAAMAAAAAAAAAAAAAAA1EZXRlcm1pbmlzdGljAAAAAAAAAAAAAAAAAAAJUmV0cmlldmFsAAAAAAAAAAAAAAAAAAAMVW52ZXJpZmlhYmxl",
        "AAAAAgAAAAAAAAAAAAAAClJlc29sdXRpb24AAAAAAAMAAAAAAAAAAAAAAAROb25lAAAAAAAAAAAAAAAGVXBoZWxkAAAAAAAAAAAAAAAAAAhSZWplY3RlZA==",
        "AAAAAQAAAAAAAAAAAAAADENvbmZpZ1JlY29yZAAAAAsAAAA5TWluaW11bSBhZ2VudCBib25kIGFzIGJwcyBvZiBlc2Nyb3dfdmFsdWUsIGUuZy4gNTAwID0gNSUuAAAAAAAAEmFnZW50X2JvbmRfbWluX2JwcwAAAAAABAAAAC9NaW5pbXVtIGNoYWxsZW5nZXIgYm9uZCBhcyBicHMgb2YgZXNjcm93X3ZhbHVlLgAAAAAXY2hhbGxlbmdlcl9ib25kX21pbl9icHMAAAAABAAAAAAAAAAPbWluX3N0YWtlX2Zsb29yAAAAAAsAAAAAAAAAFnF1b3J1bV9taW5fcmVleGVjdXRvcnMAAAAAAAQAAABRQmFzaXMgcG9pbnRzLCBtdXN0IGJlIGluIFs1MTAwLCAxMDAwMF0g4oCUIGJvdW5kcyBlbmZvcmNlZCBhdCB1cGRhdGVfY29uZmlnIHRpbWUuAAAAAAAAGHF1b3J1bV9zdXBlcm1ham9yaXR5X2JwcwAAAAQAAAClV2hlbiB0cnVlLCBvbmx5IHJlLWV4ZWN1dG9ycyB0aGUgYWRtaW4gaGFzIGFwcHJvdmVkIG1heSBhdHRlc3QuIE1lYW50CmZvciBuZXR3b3JrcyB3aGVyZSBzdGFrZSBpcyBmcmVlICh0ZXN0bmV0KSwgd2hlcmUgYW4gb3BlbiB2b3RlciBzZXQKY2FuIGJlIGNhcHR1cmVkIGF0IG5vIGNvc3QuAAAAAAAAFHJlZXhlY3V0b3JfYWxsb3dsaXN0AAAAAQAAALxTaGFyZSBvZiBhIHdyb25nLXNpZGUgcmUtZXhlY3V0b3IncyBzdGFrZSBmb3JmZWl0ZWQgd2hlbiBhIGJvbmRlZApjb25zZW5zdXMgcHJvdmVzIHRoZWlyIHZvdGUgd3JvbmcuIFNldCBvbi1jaGFpbiBzbyB0aGUgYW1vdW50IGlzIG5ldmVyCmEgY2FsbGVyJ3MgY2hvaWNlOyAwIGRpc2FibGVzIHJlLWV4ZWN1dG9yIHNsYXNoaW5nLgAAABRyZWV4ZWN1dG9yX3NsYXNoX2JwcwAAAAQAAADPU2hhcmUgb2YgYSBzbGFzaGVkIGFtb3VudCB0aGF0IGdvZXMgdG8gdGhlIHByZXZhaWxpbmcgY2hhbGxlbmdlcjsgdGhlCnJlbWFpbmRlciBnb2VzIHRvIHRoZSBhZG1pbi90cmVhc3VyeSBhY2NvdW50LiBGaXhlZCBpbiBwcmFjdGljZSDigJQKdHJlYXRlZCBhcyBlZmZlY3RpdmVseSBpbW11dGFibGUgZ292ZXJuYW5jZSwgbm90IGEgcGVyLWRpc3B1dGUgbGV2ZXIuAAAAABpzbGFzaF9zcGxpdF9jaGFsbGVuZ2VyX2JwcwAAAAAABAAAAAAAAAATd2luZG93X3RpZXJfbGFyZ2VfcwAAAAAGAAAAPmVzY3Jvd192YWx1ZSBzdHJpY3RseSBiZWxvdyB0aGlzIHVzZXMgdGhlICJzbWFsbCIgd2luZG93IHRpZXIuAAAAAAAZd2luZG93X3RpZXJfc21hbGxfY2VpbGluZwAAAAAAAAsAAAAAAAAAE3dpbmRvd190aWVyX3NtYWxsX3MAAAAABg==",
        "AAAAAQAAAAAAAAAAAAAADlJlZXhlY3V0b3JJbmZvAAAAAAAFAAAAAAAAAAZhY3RpdmUAAAAAAAEAAAB8U2V0IGJ5IHRoZSBhZG1pbiB0aHJvdWdoIEVzY3Jvd0dhdGU6OnNldF9yZWV4ZWN1dG9yX2FwcHJvdmVkLiBPbmx5CmNvbnN1bHRlZCB3aGlsZSBDb25maWdSZWNvcmQ6OnJlZXhlY3V0b3JfYWxsb3dsaXN0IGlzIG9uLgAAAAhhcHByb3ZlZAAAAAEAAAAAAAAACWpvaW5lZF9hdAAAAAAAAAYAAAD1Q291bnQgb2YgYXR0ZXN0YXRpb25zIHRoaXMgcmVleGVjdXRvciBoYXMgbWFkZSBvbiBzdWJtaXNzaW9ucyB0aGF0IGFyZQpub3QgeWV0IGZpbmFsaXplZC9yZXNvbHZlZC4gU3Rha2UgY2Fubm90IGJlIHdpdGhkcmF3biBiZWxvdwptaW5fc3Rha2VfZmxvb3Igd2hpbGUgdGhpcyBpcyBub256ZXJvIOKAlCBzZWUgRXNjcm93R2F0ZTo6d2l0aGRyYXdfc3Rha2UKYW5kIEVzY3Jvd0dhdGU6OnJlbGVhc2VfYXR0ZXN0YXRpb25fbG9jay4AAAAAAAARb3Blbl9hdHRlc3RhdGlvbnMAAAAAAAAEAAAAAAAAAAxzdGFrZV9hbW91bnQAAAAL",
        "AAAAAQAAAAAAAAAAAAAAD0NoYWxsZW5nZVJlY29yZAAAAAAFAAAAAAAAAARib25kAAAACwAAAAAAAAAKY2hhbGxlbmdlcgAAAAAAEwAAAAAAAAAJb3BlbmVkX2F0AAAAAAAABgAAAAAAAAAKcmVzb2x1dGlvbgAAAAAH0AAAAApSZXNvbHV0aW9uAAAAAAAAAAAAEXJlc29sdXRpb25fbWV0aG9kAAAAAAAH0AAAABBSZXNvbHV0aW9uTWV0aG9k",
        "AAAAAgAAA+1gTWFudWFsUmV2aWV3YCBpcyBkZWxpYmVyYXRlbHkgTk9UIGEgdmFyaWFudCBoZXJlLiBPbi1jaGFpbiByZXNvbHV0aW9uIG11c3QgYmUKZGVyaXZhYmxlIGZyb20gYWxyZWFkeS1jb21taXR0ZWQgc3RhdGUgKGF0dGVzdGF0aW9uIHRhbGxpZXMgb3IgYSByZWdpc3RlcmVkClpLIHZlcmlmaWVyJ3MgYm9vbGVhbiByZXN1bHQpIHdpdGggemVybyBhZG1pbi1kaXNjcmV0aW9uYXJ5IHBhdGhzLiBBCmNoYWxsZW5nZSB0aGF0IGNhbm5vdCBiZSByZXNvbHZlZCBleHBpcmVzIG9uLWNoYWluIGFzIGBFeHBpcmVkVW52ZXJpZmllZGAuCgpgTm9uZWAgKHJhdGhlciB0aGFuIHdyYXBwaW5nIHRoaXMgaW4gYE9wdGlvbjxSZXNvbHV0aW9uTWV0aG9kPmAgb24gdGhlCmNvbnRhaW5pbmcgc3RydWN0cykgaXMgYSBkZWxpYmVyYXRlIHNvcm9iYW4tc2RrIGNvbnRyYWN0dHlwZSB3b3JrYXJvdW5kOgpgT3B0aW9uPEN1c3RvbUVudW0+YCBmaWVsZHMgZmFpbCB0byBkZXJpdmUgdGhlaXIgU2NWYWwgY29udmVyc2lvbiBpbgpzb3JvYmFuLXNkayAyNydzICNbY29udHJhY3R0eXBlXSBtYWNybyBmb3Igc2ltcGxlIChkYXRhLWxlc3MpIGVudW1zLCBzbyBhCmRlZGljYXRlZCBgTm9uZWAgdmFyaWFudCBpcyB1c2VkIGFzIHRoZSAibm90IHlldCBzZXQiIHNlbnRpbmVsIGluc3RlYWQuCgpgV2luZG93RWxhcHNlZGAgbWFya3MgYSB2ZXJkaWN0IG5vYm9keSBhY3R1YWxseSBlc3RhYmxpc2hlZDogdGhlIHdpbmRvdwpjbG9zZWQgd2l0aG91dCBhIGJvbmRlZCBjb25zZW5zdXMuIEl0IGlzIGtlcHQgZGlzdGluY3QgZnJvbQpgUmVleGVjdXRpb25Db25zZW5zdXNgIHNvIGEgc3VibWlzc2lvbiB0aGF0IHdhcyBuZXZlciByZXBsYXllZCB0byBxdW9ydW0KY2FuIG5ldmVyIGJlIHByZXNlbnRlZCBhcyBvbmUgdGhhdCB3YXMsIGFuZCBzbyBub2JvZHkgaXMgc2xhc2hlZCBmb3IgaXQuCgpgWmtQcm9vZmAgaXMgcmVzZXJ2ZWQgZm9yIFBoYXNlIDIuIE5vIGVudHJ5cG9pbnQgYWNjZXB0cyBpdCB0b2RheS4AAAAAAAAAAAAAEFJlc29sdXRpb25NZXRob2QAAAAEAAAAAAAAAAAAAAAETm9uZQAAAAAAAAAAAAAAFFJlZXhlY3V0aW9uQ29uc2Vuc3VzAAAAAAAAAAAAAAAHWmtQcm9vZgAAAAAAAAAAAAAAAA1XaW5kb3dFbGFwc2VkAAAA",
        "AAAAAQAAAAAAAAAAAAAAEFN1Ym1pc3Npb25SZWNvcmQAAAAWAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAAC2JvbmRfYW1vdW50AAAAAAsAAAAAAAAAFWJvbmRlZF93ZWlnaHRfbWF0Y2hlZAAAAAAAAAsAAAAAAAAAGGJvbmRlZF93ZWlnaHRfbWlzbWF0Y2hlZAAAAAsAAAAAAAAAG2NmZ19jaGFsbGVuZ2VyX2JvbmRfbWluX2JwcwAAAAAEAAAAAAAAABpjZmdfcXVvcnVtX21pbl9yZWV4ZWN1dG9ycwAAAAAABAAAAAAAAAAcY2ZnX3F1b3J1bV9zdXBlcm1ham9yaXR5X2JwcwAAAAQAAAAAAAAAGGNmZ19yZWV4ZWN1dG9yX3NsYXNoX2JwcwAAAAQAAAAAAAAAHmNmZ19zbGFzaF9zcGxpdF9jaGFsbGVuZ2VyX2JwcwAAAAAABAAAAAAAAAASY2hhbGxlbmdlX3dpbmRvd19zAAAAAAAGAAAAAAAAABNjbGFpbWVkX291dHB1dF9oYXNoAAAAA+4AAAAgAAAAAAAAAAplc2Nyb3dfcmVmAAAAAAPuAAAAIAAAAAAAAAAMZXNjcm93X3ZhbHVlAAAACwAAAAAAAAAJZmluYWxpemVkAAAAAAAAAQAAAAAAAAACaWQAAAAAAAYAAAAAAAAACmlucHV0X2hhc2gAAAAAA+4AAAAgAAAAAAAAAAttYXRjaF92b3RlcwAAAAAEAAAAAAAAAA5taXNtYXRjaF92b3RlcwAAAAAABAAAAAAAAAARcmVzb2x1dGlvbl9tZXRob2QAAAAAAAfQAAAAEFJlc29sdXRpb25NZXRob2QAAAAAAAAADHN1Ym1pdHRlZF9hdAAAAAYAAAAAAAAACXRhc2tfdHlwZQAAAAAAB9AAAAAIVGFza1R5cGUAAAAAAAAAB3ZlcmRpY3QAAAAH0AAAAAdWZXJkaWN0AA==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAJgAAAAAAAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAABAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAgAAAAAAAAAITm90QWRtaW4AAAADAAAAAAAAAA1JbnZhbGlkQ29uZmlnAAAAAAAABAAAAAAAAAAIT3ZlcmZsb3cAAAAFAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAABgAAAAAAAAASU3VibWlzc2lvbk5vdEZvdW5kAAAAAAAKAAAAAAAAAApCb25kVG9vTG93AAAAAAALAAAAAAAAAA9JbnZhbGlkVGFza1R5cGUAAAAADAAAAAAAAAASSW52YWxpZEVzY3Jvd1ZhbHVlAAAAAAANAAAAAAAAABFJbnZhbGlkT3V0cHV0SGFzaAAAAAAAAA4AAAAAAAAAE1JlZXhlY3V0b3JOb3RBY3RpdmUAAAAAFAAAAAAAAAAPU3Rha2VCZWxvd0Zsb29yAAAAABUAAAAAAAAAHFN0YWtlTG9ja2VkQnlPcGVuQXR0ZXN0YXRpb24AAAAWAAAAAAAAAA9BbHJlYWR5QXR0ZXN0ZWQAAAAAFwAAAAAAAAAbUmVleGVjdXRvckFscmVhZHlSZWdpc3RlcmVkAAAAABgAAAAAAAAAGkF0dGVzdGF0aW9uQWxyZWFkeVJlbGVhc2VkAAAAAAAZAAAAAAAAABZTdWJtaXNzaW9uTm90RmluYWxpemVkAAAAAAAaAAAAAAAAABVSZWV4ZWN1dG9yTm90QXBwcm92ZWQAAAAAAAAbAAAAAAAAABNWb3RlQ29udHJhZGljdHNIYXNoAAAAABwAAAAAAAAAEUFnZW50Q2Fubm90QXR0ZXN0AAAAAAAAHQAAAAAAAAAUQ2hhbGxlbmdlQWxyZWFkeU9wZW4AAAAeAAAAAAAAABFDaGFsbGVuZ2VOb3RGb3VuZAAAAAAAAB8AAAAAAAAAFUNoYWxsZW5nZVdpbmRvd0Nsb3NlZAAAAAAAACAAAAAAAAAAGUNoYWxsZW5nZVdpbmRvd05vdEVsYXBzZWQAAAAAAAAhAAAAAAAAABVOb1VucmVzb2x2ZWRDaGFsbGVuZ2UAAAAAAAAiAAAAAAAAABhDaGFsbGVuZ2VBbHJlYWR5UmVzb2x2ZWQAAAAjAAAAAAAAABRBZ2VudENhbm5vdENoYWxsZW5nZQAAACQAAAAAAAAAF0NvbnNlbnN1c0FscmVhZHlSZWFjaGVkAAAAACUAAAAAAAAAE05vdFVwaGVsZFJlc29sdXRpb24AAAAAKAAAAAAAAAAOQWxyZWFkeVNsYXNoZWQAAAAAACkAAAAAAAAAE1BhcnR5Tm90T25Xcm9uZ1NpZGUAAAAAKgAAAAAAAAAVSW5zdWZmaWNpZW50Q29uc2Vuc3VzAAAAAAAALAAAAAAAAAAXSW52YWxpZFJlc29sdXRpb25NZXRob2QAAAAALQAAAAAAAAAMTm90U2xhc2hhYmxlAAAALgAAAAAAAAAVVmVyaWZpZXJOb3RSZWdpc3RlcmVkAAAAAAAAMgAAAAAAAAAZVmVyaWZpZXJBbHJlYWR5UmVnaXN0ZXJlZAAAAAAAADMAAAAAAAAADVByb29mUmVqZWN0ZWQAAAAAAAA0" ]),
      options
    )
  }
  public readonly fromJSON = {
    slash: this.txFromJSON<Result<i128>>,
        submit: this.txFromJSON<Result<u64>>,
        finalize: this.txFromJSON<Result<Verdict>>,
        get_admin: this.txFromJSON<Option<string>>,
        get_config: this.txFromJSON<Option<ConfigRecord>>,
        attest_replay: this.txFromJSON<Result<void>>,
        get_challenge: this.txFromJSON<Option<ChallengeRecord>>,
        update_config: this.txFromJSON<Result<void>>,
        get_submission: this.txFromJSON<Option<SubmissionRecord>>,
        open_challenge: this.txFromJSON<Result<void>>,
        withdraw_stake: this.txFromJSON<Result<void>>,
        reexecutor_info: this.txFromJSON<Option<ReexecutorInfo>>,
        resolve_challenge: this.txFromJSON<Result<Verdict>>,
        register_reexecutor: this.txFromJSON<Result<void>>,
        set_reexecutor_approved: this.txFromJSON<Result<void>>,
        release_attestation_lock: this.txFromJSON<Result<void>>
  }
}