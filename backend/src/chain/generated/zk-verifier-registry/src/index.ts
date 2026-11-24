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
   * Construct and simulate a verify_proof transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * There is no code path here that returns `true` for an unregistered
   * proof system, for any input, including empty/garbage/malformed proof
   * bytes, or bytes valid for a different registered system — this is the
   * concrete mechanism behind invariant 4. If registered (Phase 2 only),
   * this performs a real cross-contract call into the registered verifier
   * and returns its boolean unmodified; the registry never fabricates a
   * result itself.
   */
  verify_proof: ({proof_system, submission_id, proof}: {proof_system: string, submission_id: u64, proof: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a is_registered transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_registered: ({proof_system}: {proof_system: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a list_verifiers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  list_verifiers: (options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

  /**
   * Construct and simulate a register_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Additive-only, admin-gated capability grant: which proof systems
   * *exist*. EscrowGate does not consult this registry in Phase 1 — its
   * resolve_challenge rejects ZkProof outright — so registering a verifier
   * here cannot decide a dispute.
   */
  register_verifier: ({admin, proof_system, verifier_contract}: {admin: string, proof_system: string, verifier_contract: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a deregister_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Lets a compromised or retired verifier be pulled without ever adding an
   * implicit accept path elsewhere in verify_proof.
   */
  deregister_verifier: ({admin, proof_system}: {admin: string, proof_system: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin}: {admin: string},
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
    return ContractClient.deploy({admin}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAa1UaGVyZSBpcyBubyBjb2RlIHBhdGggaGVyZSB0aGF0IHJldHVybnMgYHRydWVgIGZvciBhbiB1bnJlZ2lzdGVyZWQKcHJvb2Ygc3lzdGVtLCBmb3IgYW55IGlucHV0LCBpbmNsdWRpbmcgZW1wdHkvZ2FyYmFnZS9tYWxmb3JtZWQgcHJvb2YKYnl0ZXMsIG9yIGJ5dGVzIHZhbGlkIGZvciBhIGRpZmZlcmVudCByZWdpc3RlcmVkIHN5c3RlbSDigJQgdGhpcyBpcyB0aGUKY29uY3JldGUgbWVjaGFuaXNtIGJlaGluZCBpbnZhcmlhbnQgNC4gSWYgcmVnaXN0ZXJlZCAoUGhhc2UgMiBvbmx5KSwKdGhpcyBwZXJmb3JtcyBhIHJlYWwgY3Jvc3MtY29udHJhY3QgY2FsbCBpbnRvIHRoZSByZWdpc3RlcmVkIHZlcmlmaWVyCmFuZCByZXR1cm5zIGl0cyBib29sZWFuIHVubW9kaWZpZWQ7IHRoZSByZWdpc3RyeSBuZXZlciBmYWJyaWNhdGVzIGEKcmVzdWx0IGl0c2VsZi4AAAAAAAAMdmVyaWZ5X3Byb29mAAAAAwAAAAAAAAAMcHJvb2Zfc3lzdGVtAAAAEQAAAAAAAAANc3VibWlzc2lvbl9pZAAAAAAAAAYAAAAAAAAABXByb29mAAAAAAAADgAAAAEAAAPpAAAAAQAAAAM=",
        "AAAAAAAAAGBSdW5zIG9uY2UsIGF0b21pY2FsbHkgd2l0aCBkZXBsb3ltZW50LCBzbyBub2JvZHkgYnV0IHRoZSBkZXBsb3llciBjYW4KZXZlciBjbGFpbSB0aGUgYWRtaW4gcm9sZS4AAAANX19jb25zdHJ1Y3RvcgAAAAAAAAEAAAAAAAAABWFkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAAAAAAAANaXNfcmVnaXN0ZXJlZAAAAAAAAAEAAAAAAAAADHByb29mX3N5c3RlbQAAABEAAAABAAAAAQ==",
        "AAAAAAAAAAAAAAAObGlzdF92ZXJpZmllcnMAAAAAAAAAAAABAAAD6gAAABE=",
        "AAAAAAAAAO1BZGRpdGl2ZS1vbmx5LCBhZG1pbi1nYXRlZCBjYXBhYmlsaXR5IGdyYW50OiB3aGljaCBwcm9vZiBzeXN0ZW1zCipleGlzdCouIEVzY3Jvd0dhdGUgZG9lcyBub3QgY29uc3VsdCB0aGlzIHJlZ2lzdHJ5IGluIFBoYXNlIDEg4oCUIGl0cwpyZXNvbHZlX2NoYWxsZW5nZSByZWplY3RzIFprUHJvb2Ygb3V0cmlnaHQg4oCUIHNvIHJlZ2lzdGVyaW5nIGEgdmVyaWZpZXIKaGVyZSBjYW5ub3QgZGVjaWRlIGEgZGlzcHV0ZS4AAAAAAAARcmVnaXN0ZXJfdmVyaWZpZXIAAAAAAAADAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAADHByb29mX3N5c3RlbQAAABEAAAAAAAAAEXZlcmlmaWVyX2NvbnRyYWN0AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAHdMZXRzIGEgY29tcHJvbWlzZWQgb3IgcmV0aXJlZCB2ZXJpZmllciBiZSBwdWxsZWQgd2l0aG91dCBldmVyIGFkZGluZyBhbgppbXBsaWNpdCBhY2NlcHQgcGF0aCBlbHNld2hlcmUgaW4gdmVyaWZ5X3Byb29mLgAAAAATZGVyZWdpc3Rlcl92ZXJpZmllcgAAAAACAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAADHByb29mX3N5c3RlbQAAABEAAAABAAAD6QAAAAIAAAAD",
        "AAAABQAAAAAAAAAAAAAADVByb29mVmVyaWZpZWQAAAAAAAABAAAADnByb29mX3ZlcmlmaWVkAAAAAAACAAAAAAAAAAxwcm9vZl9zeXN0ZW0AAAARAAAAAQAAAAAAAAANc3VibWlzc2lvbl9pZAAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAElZlcmlmaWVyUmVnaXN0ZXJlZAAAAAAAAQAAABN2ZXJpZmllcl9yZWdpc3RlcmVkAAAAAAIAAAAAAAAADHByb29mX3N5c3RlbQAAABEAAAABAAAAAAAAABF2ZXJpZmllcl9jb250cmFjdAAAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAFFZlcmlmaWVyRGVyZWdpc3RlcmVkAAAAAQAAABV2ZXJpZmllcl9kZXJlZ2lzdGVyZWQAAAAAAAABAAAAAAAAAAxwcm9vZl9zeXN0ZW0AAAARAAAAAQAAAAI=",
        "AAAAAgAAAAAAAAAAAAAAB1ZlcmRpY3QAAAAABQAAAAAAAAAAAAAAB1BlbmRpbmcAAAAAAAAAAAAAAAAIVmVyaWZpZWQAAAAAAAAAAAAAAAhEaXNwdXRlZAAAAAAAAAAAAAAAB1NsYXNoZWQAAAAAAAAAAAAAAAARRXhwaXJlZFVudmVyaWZpZWQAAAA=",
        "AAAAAgAAALhUaGUgc2hhcGUgb2YgdGFzayBhIHN1Ym1pc3Npb24gY2xhaW1zIHRvIGhhdmUgY29tcGxldGVkLgpgVW52ZXJpZmlhYmxlYCBpcyByZXNlcnZlZDogYEVzY3Jvd0dhdGU6OnN1Ym1pdGAgcmVqZWN0cyBpdCB3aXRoCmBFcnJvcjo6SW52YWxpZFRhc2tUeXBlYCwgc28gbm8gc3VibWlzc2lvbiBjYW4gY2FycnkgaXQgdG9kYXkuAAAAAAAAAAhUYXNrVHlwZQAAAAMAAAAAAAAAAAAAAA1EZXRlcm1pbmlzdGljAAAAAAAAAAAAAAAAAAAJUmV0cmlldmFsAAAAAAAAAAAAAAAAAAAMVW52ZXJpZmlhYmxl",
        "AAAAAgAAAAAAAAAAAAAAClJlc29sdXRpb24AAAAAAAMAAAAAAAAAAAAAAAROb25lAAAAAAAAAAAAAAAGVXBoZWxkAAAAAAAAAAAAAAAAAAhSZWplY3RlZA==",
        "AAAAAQAAAAAAAAAAAAAADENvbmZpZ1JlY29yZAAAAAsAAAA5TWluaW11bSBhZ2VudCBib25kIGFzIGJwcyBvZiBlc2Nyb3dfdmFsdWUsIGUuZy4gNTAwID0gNSUuAAAAAAAAEmFnZW50X2JvbmRfbWluX2JwcwAAAAAABAAAAC9NaW5pbXVtIGNoYWxsZW5nZXIgYm9uZCBhcyBicHMgb2YgZXNjcm93X3ZhbHVlLgAAAAAXY2hhbGxlbmdlcl9ib25kX21pbl9icHMAAAAABAAAAAAAAAAPbWluX3N0YWtlX2Zsb29yAAAAAAsAAAAAAAAAFnF1b3J1bV9taW5fcmVleGVjdXRvcnMAAAAAAAQAAABRQmFzaXMgcG9pbnRzLCBtdXN0IGJlIGluIFs1MTAwLCAxMDAwMF0g4oCUIGJvdW5kcyBlbmZvcmNlZCBhdCB1cGRhdGVfY29uZmlnIHRpbWUuAAAAAAAAGHF1b3J1bV9zdXBlcm1ham9yaXR5X2JwcwAAAAQAAAClV2hlbiB0cnVlLCBvbmx5IHJlLWV4ZWN1dG9ycyB0aGUgYWRtaW4gaGFzIGFwcHJvdmVkIG1heSBhdHRlc3QuIE1lYW50CmZvciBuZXR3b3JrcyB3aGVyZSBzdGFrZSBpcyBmcmVlICh0ZXN0bmV0KSwgd2hlcmUgYW4gb3BlbiB2b3RlciBzZXQKY2FuIGJlIGNhcHR1cmVkIGF0IG5vIGNvc3QuAAAAAAAAFHJlZXhlY3V0b3JfYWxsb3dsaXN0AAAAAQAAALxTaGFyZSBvZiBhIHdyb25nLXNpZGUgcmUtZXhlY3V0b3IncyBzdGFrZSBmb3JmZWl0ZWQgd2hlbiBhIGJvbmRlZApjb25zZW5zdXMgcHJvdmVzIHRoZWlyIHZvdGUgd3JvbmcuIFNldCBvbi1jaGFpbiBzbyB0aGUgYW1vdW50IGlzIG5ldmVyCmEgY2FsbGVyJ3MgY2hvaWNlOyAwIGRpc2FibGVzIHJlLWV4ZWN1dG9yIHNsYXNoaW5nLgAAABRyZWV4ZWN1dG9yX3NsYXNoX2JwcwAAAAQAAADPU2hhcmUgb2YgYSBzbGFzaGVkIGFtb3VudCB0aGF0IGdvZXMgdG8gdGhlIHByZXZhaWxpbmcgY2hhbGxlbmdlcjsgdGhlCnJlbWFpbmRlciBnb2VzIHRvIHRoZSBhZG1pbi90cmVhc3VyeSBhY2NvdW50LiBGaXhlZCBpbiBwcmFjdGljZSDigJQKdHJlYXRlZCBhcyBlZmZlY3RpdmVseSBpbW11dGFibGUgZ292ZXJuYW5jZSwgbm90IGEgcGVyLWRpc3B1dGUgbGV2ZXIuAAAAABpzbGFzaF9zcGxpdF9jaGFsbGVuZ2VyX2JwcwAAAAAABAAAAAAAAAATd2luZG93X3RpZXJfbGFyZ2VfcwAAAAAGAAAAPmVzY3Jvd192YWx1ZSBzdHJpY3RseSBiZWxvdyB0aGlzIHVzZXMgdGhlICJzbWFsbCIgd2luZG93IHRpZXIuAAAAAAAZd2luZG93X3RpZXJfc21hbGxfY2VpbGluZwAAAAAAAAsAAAAAAAAAE3dpbmRvd190aWVyX3NtYWxsX3MAAAAABg==",
        "AAAAAQAAAAAAAAAAAAAADlJlZXhlY3V0b3JJbmZvAAAAAAAFAAAAAAAAAAZhY3RpdmUAAAAAAAEAAAB8U2V0IGJ5IHRoZSBhZG1pbiB0aHJvdWdoIEVzY3Jvd0dhdGU6OnNldF9yZWV4ZWN1dG9yX2FwcHJvdmVkLiBPbmx5CmNvbnN1bHRlZCB3aGlsZSBDb25maWdSZWNvcmQ6OnJlZXhlY3V0b3JfYWxsb3dsaXN0IGlzIG9uLgAAAAhhcHByb3ZlZAAAAAEAAAAAAAAACWpvaW5lZF9hdAAAAAAAAAYAAAD1Q291bnQgb2YgYXR0ZXN0YXRpb25zIHRoaXMgcmVleGVjdXRvciBoYXMgbWFkZSBvbiBzdWJtaXNzaW9ucyB0aGF0IGFyZQpub3QgeWV0IGZpbmFsaXplZC9yZXNvbHZlZC4gU3Rha2UgY2Fubm90IGJlIHdpdGhkcmF3biBiZWxvdwptaW5fc3Rha2VfZmxvb3Igd2hpbGUgdGhpcyBpcyBub256ZXJvIOKAlCBzZWUgRXNjcm93R2F0ZTo6d2l0aGRyYXdfc3Rha2UKYW5kIEVzY3Jvd0dhdGU6OnJlbGVhc2VfYXR0ZXN0YXRpb25fbG9jay4AAAAAAAARb3Blbl9hdHRlc3RhdGlvbnMAAAAAAAAEAAAAAAAAAAxzdGFrZV9hbW91bnQAAAAL",
        "AAAAAQAAAAAAAAAAAAAAD0NoYWxsZW5nZVJlY29yZAAAAAAFAAAAAAAAAARib25kAAAACwAAAAAAAAAKY2hhbGxlbmdlcgAAAAAAEwAAAAAAAAAJb3BlbmVkX2F0AAAAAAAABgAAAAAAAAAKcmVzb2x1dGlvbgAAAAAH0AAAAApSZXNvbHV0aW9uAAAAAAAAAAAAEXJlc29sdXRpb25fbWV0aG9kAAAAAAAH0AAAABBSZXNvbHV0aW9uTWV0aG9k",
        "AAAAAgAAA+1gTWFudWFsUmV2aWV3YCBpcyBkZWxpYmVyYXRlbHkgTk9UIGEgdmFyaWFudCBoZXJlLiBPbi1jaGFpbiByZXNvbHV0aW9uIG11c3QgYmUKZGVyaXZhYmxlIGZyb20gYWxyZWFkeS1jb21taXR0ZWQgc3RhdGUgKGF0dGVzdGF0aW9uIHRhbGxpZXMgb3IgYSByZWdpc3RlcmVkClpLIHZlcmlmaWVyJ3MgYm9vbGVhbiByZXN1bHQpIHdpdGggemVybyBhZG1pbi1kaXNjcmV0aW9uYXJ5IHBhdGhzLiBBCmNoYWxsZW5nZSB0aGF0IGNhbm5vdCBiZSByZXNvbHZlZCBleHBpcmVzIG9uLWNoYWluIGFzIGBFeHBpcmVkVW52ZXJpZmllZGAuCgpgTm9uZWAgKHJhdGhlciB0aGFuIHdyYXBwaW5nIHRoaXMgaW4gYE9wdGlvbjxSZXNvbHV0aW9uTWV0aG9kPmAgb24gdGhlCmNvbnRhaW5pbmcgc3RydWN0cykgaXMgYSBkZWxpYmVyYXRlIHNvcm9iYW4tc2RrIGNvbnRyYWN0dHlwZSB3b3JrYXJvdW5kOgpgT3B0aW9uPEN1c3RvbUVudW0+YCBmaWVsZHMgZmFpbCB0byBkZXJpdmUgdGhlaXIgU2NWYWwgY29udmVyc2lvbiBpbgpzb3JvYmFuLXNkayAyNydzICNbY29udHJhY3R0eXBlXSBtYWNybyBmb3Igc2ltcGxlIChkYXRhLWxlc3MpIGVudW1zLCBzbyBhCmRlZGljYXRlZCBgTm9uZWAgdmFyaWFudCBpcyB1c2VkIGFzIHRoZSAibm90IHlldCBzZXQiIHNlbnRpbmVsIGluc3RlYWQuCgpgV2luZG93RWxhcHNlZGAgbWFya3MgYSB2ZXJkaWN0IG5vYm9keSBhY3R1YWxseSBlc3RhYmxpc2hlZDogdGhlIHdpbmRvdwpjbG9zZWQgd2l0aG91dCBhIGJvbmRlZCBjb25zZW5zdXMuIEl0IGlzIGtlcHQgZGlzdGluY3QgZnJvbQpgUmVleGVjdXRpb25Db25zZW5zdXNgIHNvIGEgc3VibWlzc2lvbiB0aGF0IHdhcyBuZXZlciByZXBsYXllZCB0byBxdW9ydW0KY2FuIG5ldmVyIGJlIHByZXNlbnRlZCBhcyBvbmUgdGhhdCB3YXMsIGFuZCBzbyBub2JvZHkgaXMgc2xhc2hlZCBmb3IgaXQuCgpgWmtQcm9vZmAgaXMgcmVzZXJ2ZWQgZm9yIFBoYXNlIDIuIE5vIGVudHJ5cG9pbnQgYWNjZXB0cyBpdCB0b2RheS4AAAAAAAAAAAAAEFJlc29sdXRpb25NZXRob2QAAAAEAAAAAAAAAAAAAAAETm9uZQAAAAAAAAAAAAAAFFJlZXhlY3V0aW9uQ29uc2Vuc3VzAAAAAAAAAAAAAAAHWmtQcm9vZgAAAAAAAAAAAAAAAA1XaW5kb3dFbGFwc2VkAAAA",
        "AAAAAQAAAAAAAAAAAAAAEFN1Ym1pc3Npb25SZWNvcmQAAAAWAAAAAAAAAAVhZ2VudAAAAAAAABMAAAAAAAAAC2JvbmRfYW1vdW50AAAAAAsAAAAAAAAAFWJvbmRlZF93ZWlnaHRfbWF0Y2hlZAAAAAAAAAsAAAAAAAAAGGJvbmRlZF93ZWlnaHRfbWlzbWF0Y2hlZAAAAAsAAAAAAAAAG2NmZ19jaGFsbGVuZ2VyX2JvbmRfbWluX2JwcwAAAAAEAAAAAAAAABpjZmdfcXVvcnVtX21pbl9yZWV4ZWN1dG9ycwAAAAAABAAAAAAAAAAcY2ZnX3F1b3J1bV9zdXBlcm1ham9yaXR5X2JwcwAAAAQAAAAAAAAAGGNmZ19yZWV4ZWN1dG9yX3NsYXNoX2JwcwAAAAQAAAAAAAAAHmNmZ19zbGFzaF9zcGxpdF9jaGFsbGVuZ2VyX2JwcwAAAAAABAAAAAAAAAASY2hhbGxlbmdlX3dpbmRvd19zAAAAAAAGAAAAAAAAABNjbGFpbWVkX291dHB1dF9oYXNoAAAAA+4AAAAgAAAAAAAAAAplc2Nyb3dfcmVmAAAAAAPuAAAAIAAAAAAAAAAMZXNjcm93X3ZhbHVlAAAACwAAAAAAAAAJZmluYWxpemVkAAAAAAAAAQAAAAAAAAACaWQAAAAAAAYAAAAAAAAACmlucHV0X2hhc2gAAAAAA+4AAAAgAAAAAAAAAAttYXRjaF92b3RlcwAAAAAEAAAAAAAAAA5taXNtYXRjaF92b3RlcwAAAAAABAAAAAAAAAARcmVzb2x1dGlvbl9tZXRob2QAAAAAAAfQAAAAEFJlc29sdXRpb25NZXRob2QAAAAAAAAADHN1Ym1pdHRlZF9hdAAAAAYAAAAAAAAACXRhc2tfdHlwZQAAAAAAB9AAAAAIVGFza1R5cGUAAAAAAAAAB3ZlcmRpY3QAAAAH0AAAAAdWZXJkaWN0AA==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAJQAAAAAAAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAABAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAgAAAAAAAAAITm90QWRtaW4AAAADAAAAAAAAAA1JbnZhbGlkQ29uZmlnAAAAAAAABAAAAAAAAAAIT3ZlcmZsb3cAAAAFAAAAAAAAAA1JbnZhbGlkQW1vdW50AAAAAAAABgAAAAAAAAASU3VibWlzc2lvbk5vdEZvdW5kAAAAAAAKAAAAAAAAAApCb25kVG9vTG93AAAAAAALAAAAAAAAAA9JbnZhbGlkVGFza1R5cGUAAAAADAAAAAAAAAASSW52YWxpZEVzY3Jvd1ZhbHVlAAAAAAANAAAAAAAAABFJbnZhbGlkT3V0cHV0SGFzaAAAAAAAAA4AAAAAAAAAE1JlZXhlY3V0b3JOb3RBY3RpdmUAAAAAFAAAAAAAAAAPU3Rha2VCZWxvd0Zsb29yAAAAABUAAAAAAAAAHFN0YWtlTG9ja2VkQnlPcGVuQXR0ZXN0YXRpb24AAAAWAAAAAAAAAA9BbHJlYWR5QXR0ZXN0ZWQAAAAAFwAAAAAAAAAbUmVleGVjdXRvckFscmVhZHlSZWdpc3RlcmVkAAAAABgAAAAAAAAAGkF0dGVzdGF0aW9uQWxyZWFkeVJlbGVhc2VkAAAAAAAZAAAAAAAAABZTdWJtaXNzaW9uTm90RmluYWxpemVkAAAAAAAaAAAAAAAAABVSZWV4ZWN1dG9yTm90QXBwcm92ZWQAAAAAAAAbAAAAAAAAABNWb3RlQ29udHJhZGljdHNIYXNoAAAAABwAAAAAAAAAEUFnZW50Q2Fubm90QXR0ZXN0AAAAAAAAHQAAAAAAAAAUQ2hhbGxlbmdlQWxyZWFkeU9wZW4AAAAeAAAAAAAAABFDaGFsbGVuZ2VOb3RGb3VuZAAAAAAAAB8AAAAAAAAAFUNoYWxsZW5nZVdpbmRvd0Nsb3NlZAAAAAAAACAAAAAAAAAAGUNoYWxsZW5nZVdpbmRvd05vdEVsYXBzZWQAAAAAAAAhAAAAAAAAABVOb1VucmVzb2x2ZWRDaGFsbGVuZ2UAAAAAAAAiAAAAAAAAABhDaGFsbGVuZ2VBbHJlYWR5UmVzb2x2ZWQAAAAjAAAAAAAAABRBZ2VudENhbm5vdENoYWxsZW5nZQAAACQAAAAAAAAAE05vdFVwaGVsZFJlc29sdXRpb24AAAAAKAAAAAAAAAAOQWxyZWFkeVNsYXNoZWQAAAAAACkAAAAAAAAAE1BhcnR5Tm90T25Xcm9uZ1NpZGUAAAAAKgAAAAAAAAAVSW5zdWZmaWNpZW50Q29uc2Vuc3VzAAAAAAAALAAAAAAAAAAXSW52YWxpZFJlc29sdXRpb25NZXRob2QAAAAALQAAAAAAAAAMTm90U2xhc2hhYmxlAAAALgAAAAAAAAAVVmVyaWZpZXJOb3RSZWdpc3RlcmVkAAAAAAAAMgAAAAAAAAAZVmVyaWZpZXJBbHJlYWR5UmVnaXN0ZXJlZAAAAAAAADMAAAAAAAAADVByb29mUmVqZWN0ZWQAAAAAAAA0" ]),
      options
    )
  }
  public readonly fromJSON = {
    verify_proof: this.txFromJSON<Result<boolean>>,
        is_registered: this.txFromJSON<boolean>,
        list_verifiers: this.txFromJSON<Array<string>>,
        register_verifier: this.txFromJSON<Result<void>>,
        deregister_verifier: this.txFromJSON<Result<void>>
  }
}