use soroban_sdk::{contracttype, Address};

/// The shape of task a submission claims to have completed.
/// `Unverifiable` is reserved: `EscrowGate::submit` rejects it with
/// `Error::InvalidTaskType`, so no submission can carry it today.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskType {
    Deterministic,
    Retrieval,
    Unverifiable,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Pending,
    Verified,
    Disputed,
    Slashed,
    ExpiredUnverified,
}

/// `ManualReview` is deliberately NOT a variant here. On-chain resolution must be
/// derivable from already-committed state (attestation tallies or a registered
/// ZK verifier's boolean result) with zero admin-discretionary paths. A
/// challenge that cannot be resolved expires on-chain as `ExpiredUnverified`.
///
/// `None` (rather than wrapping this in `Option<ResolutionMethod>` on the
/// containing structs) is a deliberate soroban-sdk contracttype workaround:
/// `Option<CustomEnum>` fields fail to derive their ScVal conversion in
/// soroban-sdk 27's #[contracttype] macro for simple (data-less) enums, so a
/// dedicated `None` variant is used as the "not yet set" sentinel instead.
///
/// `WindowElapsed` marks a verdict nobody actually established: the window
/// closed without a bonded consensus. It is kept distinct from
/// `ReexecutionConsensus` so a submission that was never replayed to quorum
/// can never be presented as one that was, and so nobody is slashed for it.
///
/// `ZkProof` is reserved for Phase 2. No entrypoint accepts it today.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolutionMethod {
    None,
    ReexecutionConsensus,
    ZkProof,
    WindowElapsed,
}

#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Resolution {
    None,
    Upheld,
    Rejected,
    /// Nobody resolved the challenge before it lapsed, and both bonds went
    /// back. Written by `finalize`, never chosen by a caller.
    Expired,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ConfigRecord {
    pub min_stake_floor: i128,
    pub quorum_min_reexecutors: u32,
    /// Basis points, must be in [5100, 10000] — bounds enforced at update_config time.
    pub quorum_supermajority_bps: u32,
    /// Minimum agent bond as bps of escrow_value, e.g. 500 = 5%.
    pub agent_bond_min_bps: u32,
    /// Minimum challenger bond as bps of escrow_value.
    pub challenger_bond_min_bps: u32,
    /// escrow_value strictly below this uses the "small" window tier.
    pub window_tier_small_ceiling: i128,
    pub window_tier_small_s: u64,
    pub window_tier_large_s: u64,
    /// Share of a slashed amount that goes to the prevailing challenger; the
    /// remainder goes to the admin/treasury account. Fixed in practice —
    /// treated as effectively immutable governance, not a per-dispute lever.
    pub slash_split_challenger_bps: u32,
    /// Share of a wrong-side re-executor's stake forfeited when a bonded
    /// consensus proves their vote wrong. Set on-chain so the amount is never
    /// a caller's choice; 0 disables re-executor slashing.
    pub reexecutor_slash_bps: u32,
    /// When true, only re-executors the admin has approved may attest. Meant
    /// for networks where stake is free (testnet), where an open voter set
    /// can be captured at no cost.
    pub reexecutor_allowlist: bool,
}

impl ConfigRecord {
    pub const MIN_WINDOW_S: u64 = 600;
    pub const MIN_SUPERMAJORITY_BPS: u32 = 5100;
    pub const MAX_BPS: u32 = 10000;
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct SubmissionRecord {
    pub id: u64,
    pub agent: Address,
    pub escrow_ref: soroban_sdk::BytesN<32>,
    pub escrow_value: i128,
    pub task_type: TaskType,
    pub input_hash: soroban_sdk::BytesN<32>,
    pub claimed_output_hash: soroban_sdk::BytesN<32>,
    pub bond_amount: i128,
    pub submitted_at: u64,
    pub challenge_window_s: u64,
    pub verdict: Verdict,
    pub finalized: bool,
    pub match_votes: u32,
    pub mismatch_votes: u32,
    pub bonded_weight_matched: i128,
    pub bonded_weight_mismatched: i128,
    pub resolution_method: ResolutionMethod,
    // Config values snapshotted at submit() time, so a later admin config change
    // never retroactively changes an in-flight submission's rules.
    pub cfg_quorum_min_reexecutors: u32,
    pub cfg_quorum_supermajority_bps: u32,
    pub cfg_slash_split_challenger_bps: u32,
    pub cfg_challenger_bond_min_bps: u32,
    pub cfg_reexecutor_slash_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ChallengeRecord {
    pub challenger: Address,
    pub bond: i128,
    pub opened_at: u64,
    pub resolution: Resolution,
    pub resolution_method: ResolutionMethod,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ReexecutorInfo {
    pub stake_amount: i128,
    pub active: bool,
    pub joined_at: u64,
    /// Count of attestations this reexecutor has made on submissions that are
    /// not yet finalized/resolved. Stake cannot be withdrawn below
    /// min_stake_floor while this is nonzero — see EscrowGate::withdraw_stake
    /// and EscrowGate::release_attestation_lock.
    pub open_attestations: u32,
    /// Set by the admin through EscrowGate::set_reexecutor_approved. Only
    /// consulted while ConfigRecord::reexecutor_allowlist is on.
    pub approved: bool,
}
