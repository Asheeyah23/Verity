// Tests link std (needed by proptest and the std::vec::Vec used in the
// proptest model harness); the actual deployed contract build stays no_std.
#![cfg_attr(not(test), no_std)]
// submit()'s 8 scalar args mirror the PRD §8 entrypoint signature (plus the
// escrow_value this design adds) — a Soroban contract entrypoint, not an
// internal API a caller would otherwise want bundled into a struct.
#![allow(clippy::too_many_arguments)]

mod events;
mod storage;

use events::{
    ChallengeExpired, ChallengeOpened, ChallengeResolved, Finalized, ReexecutorApprovalChanged,
    ReexecutorRegistered, ReexecutorStakeWithdrawn, ReplayAttested, Slashed, SubmissionCreated,
};
use soroban_sdk::{contract, contractimpl, panic_with_error, Address, BytesN, Env};
use verity_common::{
    ChallengeRecord, ConfigRecord, Error, ReexecutorInfo, Resolution, ResolutionMethod,
    SubmissionRecord, TaskType, Verdict,
};

const MAX_BPS: i128 = 10_000;

// Maximum allowed challenge window (7 days).
// Reasoning: the longest a submission legitimately lives is its window plus,
// if challenged late, one further window for challenge expiry (~2x window = 14 days),
// well inside the ~28.9 day (500,000 ledgers) persistent storage extension (`BUMP_TO` in storage.rs).
pub const MAX_WINDOW_S: u64 = 7 * 24 * 60 * 60; // 604_800

fn checked_bps(value: i128, bps: u32) -> Result<i128, Error> {
    let product = value.checked_mul(bps as i128).ok_or(Error::Overflow)?;
    product.checked_div(MAX_BPS).ok_or(Error::Overflow)
}

fn validate_config(cfg: &ConfigRecord) -> Result<(), Error> {
    if cfg.quorum_supermajority_bps < ConfigRecord::MIN_SUPERMAJORITY_BPS
        || cfg.quorum_supermajority_bps > ConfigRecord::MAX_BPS
    {
        return Err(Error::InvalidConfig);
    }
    if cfg.window_tier_small_s < ConfigRecord::MIN_WINDOW_S
        || cfg.window_tier_small_s > MAX_WINDOW_S
        || cfg.window_tier_large_s < ConfigRecord::MIN_WINDOW_S
        || cfg.window_tier_large_s > MAX_WINDOW_S
    {
        return Err(Error::InvalidConfig);
    }
    // The tiers exist so that a larger escrow can be challenged for longer.
    // With the small window the longer one, submit() would give a small job
    // more time than a large one. Equal windows are fine: one window for
    // every escrow, as the dev deployment has.
    if cfg.window_tier_small_s > cfg.window_tier_large_s {
        return Err(Error::InvalidConfig);
    }
    if cfg.agent_bond_min_bps == 0 || cfg.agent_bond_min_bps > ConfigRecord::MAX_BPS {
        return Err(Error::InvalidConfig);
    }
    if cfg.challenger_bond_min_bps == 0 || cfg.challenger_bond_min_bps > ConfigRecord::MAX_BPS {
        return Err(Error::InvalidConfig);
    }
    if cfg.slash_split_challenger_bps > ConfigRecord::MAX_BPS {
        return Err(Error::InvalidConfig);
    }
    if cfg.reexecutor_slash_bps > ConfigRecord::MAX_BPS {
        return Err(Error::InvalidConfig);
    }
    if cfg.quorum_min_reexecutors == 0 {
        return Err(Error::InvalidConfig);
    }
    if cfg.window_tier_small_ceiling < 0 {
        return Err(Error::InvalidConfig);
    }
    // A floor of zero (or less) would keep a re-executor that has withdrawn all
    // of its stake "active", and its votes would still count toward the quorum.
    if cfg.min_stake_floor <= 0 {
        return Err(Error::InvalidConfig);
    }
    Ok(())
}

/// Supermajority check on already-tallied bonded vote weight. Returns the
/// implied terminal verdict once BOTH a minimum voter count and a bonded
/// supermajority in one direction are reached; None while the outcome is
/// still contested or under-quorate.
fn consensus_outcome(sub: &SubmissionRecord) -> Result<Option<Verdict>, Error> {
    let total_votes = sub.match_votes + sub.mismatch_votes;
    if total_votes < sub.cfg_quorum_min_reexecutors {
        return Ok(None);
    }
    let total_weight = sub
        .bonded_weight_matched
        .checked_add(sub.bonded_weight_mismatched)
        .ok_or(Error::Overflow)?;
    if total_weight <= 0 {
        return Ok(None);
    }
    let rhs = total_weight
        .checked_mul(sub.cfg_quorum_supermajority_bps as i128)
        .ok_or(Error::Overflow)?;
    let match_lhs = sub
        .bonded_weight_matched
        .checked_mul(MAX_BPS)
        .ok_or(Error::Overflow)?;
    if match_lhs >= rhs {
        return Ok(Some(Verdict::Verified));
    }
    let mismatch_lhs = sub
        .bonded_weight_mismatched
        .checked_mul(MAX_BPS)
        .ok_or(Error::Overflow)?;
    if mismatch_lhs >= rhs {
        return Ok(Some(Verdict::Slashed));
    }
    Ok(None)
}

/// Moves every bond this submission holds to where the terminal verdict says
/// it belongs. After this runs the contract custodies nothing for the
/// submission: both the agent's bond and (if a challenge was opened) the
/// challenger's bond have been paid out.
///
/// - Verified: the agent's bond is returned. A challenger who disputed it
///   and lost forfeits their bond to the agent they wrongly accused — that
///   forfeit is what makes a frivolous challenge cost something.
/// - Slashed: the agent's bond is forfeited. A prevailing challenger gets
///   their own bond back plus slash_split_challenger_bps of the agent's; the
///   rest (or all of it, absent a challenger) goes to the admin/treasury.
/// - ExpiredUnverified: nothing was established either way — an unresolved
///   challenge, or a window that closed without quorum while a re-executor
///   had reported a mismatch — so nobody was proven wrong and every bond
///   goes back to its owner.
fn settle(e: &Env, sub: &SubmissionRecord) -> Result<(), Error> {
    let bond_asset = storage::get_bond_asset(e).ok_or(Error::NotInitialized)?;
    let token = soroban_sdk::token::TokenClient::new(e, &bond_asset);
    let contract_address = e.current_contract_address();
    let challenge = storage::get_challenge(e, sub.id);
    let pay = |to: &Address, amount: i128| {
        if amount > 0 {
            token.transfer(&contract_address, to.clone(), &amount);
        }
    };
    match sub.verdict {
        Verdict::Verified => {
            let forfeited = challenge.as_ref().map(|c| c.bond).unwrap_or(0);
            let total = sub.bond_amount.checked_add(forfeited).ok_or(Error::Overflow)?;
            pay(&sub.agent, total);
        }
        Verdict::Slashed => {
            let admin = storage::get_admin(e).ok_or(Error::NotInitialized)?;
            if let Some(chal) = challenge {
                let challenger_share =
                    checked_bps(sub.bond_amount, sub.cfg_slash_split_challenger_bps)?;
                let remainder = sub
                    .bond_amount
                    .checked_sub(challenger_share)
                    .ok_or(Error::Overflow)?;
                let to_challenger = chal.bond.checked_add(challenger_share).ok_or(Error::Overflow)?;
                pay(&chal.challenger, to_challenger);
                pay(&admin, remainder);
            } else {
                // Pure replay-consensus slash: no challenger exists to reward,
                // so the forfeited agent bond routes to the admin/treasury
                // account configured in the constructor.
                pay(&admin, sub.bond_amount);
            }
        }
        Verdict::ExpiredUnverified => {
            pay(&sub.agent, sub.bond_amount);
            if let Some(chal) = challenge {
                pay(&chal.challenger, chal.bond);
            }
        }
        _ => {}
    }
    Ok(())
}

/// Which side of a consensus verdict was proven wrong: `Some(true)` means the
/// "matched" voters were wrong (the submission was slashed), `Some(false)`
/// the "mismatch" voters. `None` whenever no bonded consensus established the
/// verdict — a window that merely elapsed proves nobody wrong, so nobody is
/// slashable for it.
fn wrong_vote(sub: &SubmissionRecord) -> Option<bool> {
    if !sub.finalized || sub.resolution_method != ResolutionMethod::ReexecutionConsensus {
        return None;
    }
    match sub.verdict {
        Verdict::Verified => Some(false),
        Verdict::Slashed => Some(true),
        _ => None,
    }
}

/// Forfeits cfg_reexecutor_slash_bps of `info`'s stake and pays it out. The
/// amount is fixed by the config snapshotted at submit() time, never by the
/// caller. The caller persists `info` and has already checked that this
/// re-executor's recorded vote is on the wrong side and not yet slashed.
/// Returns the amount forfeited; 0 means slashing is disabled and nothing
/// was recorded.
fn apply_slash(
    e: &Env,
    sub: &SubmissionRecord,
    reexecutor: &Address,
    info: &mut ReexecutorInfo,
) -> Result<i128, Error> {
    let amount = checked_bps(info.stake_amount, sub.cfg_reexecutor_slash_bps)?;
    if amount <= 0 {
        return Ok(0);
    }
    let cfg = storage::get_config(e).ok_or(Error::NotInitialized)?;
    info.stake_amount = info.stake_amount.checked_sub(amount).ok_or(Error::Overflow)?;
    info.active = info.stake_amount >= cfg.min_stake_floor;
    storage::mark_slashed(e, sub.id, reexecutor);

    let bond_asset = storage::get_bond_asset(e).ok_or(Error::NotInitialized)?;
    let token = soroban_sdk::token::TokenClient::new(e, &bond_asset);
    let contract_address = e.current_contract_address();
    let admin = storage::get_admin(e).ok_or(Error::NotInitialized)?;
    // Only a challenger whose challenge was upheld earns a share; one who
    // lost has no claim on the stake of the voters who disagreed with them.
    let prevailing_challenger = storage::get_challenge(e, sub.id)
        .filter(|chal| chal.resolution == Resolution::Upheld)
        .map(|chal| chal.challenger);
    let challenger_share = match &prevailing_challenger {
        Some(_) => checked_bps(amount, sub.cfg_slash_split_challenger_bps)?,
        None => 0,
    };
    let remainder = amount.checked_sub(challenger_share).ok_or(Error::Overflow)?;
    if let Some(challenger) = prevailing_challenger {
        if challenger_share > 0 {
            token.transfer(&contract_address, challenger, &challenger_share);
        }
    }
    if remainder > 0 {
        token.transfer(&contract_address, admin, &remainder);
    }

    Slashed { submission_id: sub.id, reexecutor: reexecutor.clone(), amount }.publish(e);
    Ok(amount)
}

#[contract]
pub struct EscrowGate;

#[contractimpl]
impl EscrowGate {
    /// Runs once, atomically with deployment, so there is no window in which
    /// somebody other than the deployer can claim the admin role.
    pub fn __constructor(e: Env, admin: Address, bond_asset: Address, config: ConfigRecord) {
        if let Err(err) = validate_config(&config) {
            panic_with_error!(&e, err);
        }
        storage::set_admin(&e, &admin);
        storage::set_bond_asset(&e, &bond_asset);
        storage::set_config(&e, &config);
    }

    /// Admin-gated, additive capability change only (which knobs future
    /// submissions use) — never a per-submission or per-dispute override.
    /// Every SubmissionRecord snapshots the config values that govern it at
    /// submit() time, so this can never retroactively change an in-flight
    /// submission's rules.
    pub fn update_config(e: Env, admin: Address, config: ConfigRecord) -> Result<(), Error> {
        let stored_admin = storage::get_admin(&e).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(Error::NotAdmin);
        }
        validate_config(&config)?;
        storage::set_config(&e, &config);
        storage::bump_instance(&e);
        Ok(())
    }

    /// Admin-gated membership of the voter set, consulted by attest_replay
    /// while ConfigRecord::reexecutor_allowlist is on. This is a real admin
    /// power: the admin decides who may vote. It exists because bonded
    /// consensus is only as strong as the cost of the bond, and on a network
    /// where stake is free an open voter set can be captured for nothing.
    /// It never decides an individual verdict — every verdict still comes
    /// from the votes the approved set casts.
    pub fn set_reexecutor_approved(
        e: Env,
        admin: Address,
        reexecutor: Address,
        approved: bool,
    ) -> Result<(), Error> {
        let stored_admin = storage::get_admin(&e).ok_or(Error::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(Error::NotAdmin);
        }
        let mut info = storage::get_reexecutor(&e, &reexecutor).ok_or(Error::ReexecutorNotActive)?;
        info.approved = approved;
        storage::set_reexecutor(&e, &reexecutor, &info);
        storage::bump_instance(&e);

        ReexecutorApprovalChanged { reexecutor, approved }.publish(&e);
        Ok(())
    }

    pub fn submit(
        e: Env,
        agent: Address,
        escrow_ref: BytesN<32>,
        escrow_value: i128,
        task_type: TaskType,
        input_hash: BytesN<32>,
        output_hash: BytesN<32>,
        bond: i128,
    ) -> Result<u64, Error> {
        agent.require_auth();
        if escrow_value <= 0 {
            return Err(Error::InvalidEscrowValue);
        }
        // All zeros is what a re-executor reports when it could not produce
        // an output at all; a claim of it would make that honest "no output"
        // vote indistinguishable from agreement with the claim.
        if output_hash == BytesN::from_array(&e, &[0u8; 32]) {
            return Err(Error::InvalidOutputHash);
        }
        // v1 only covers deterministic-replayable and statistically
        // spot-checkable retrieval tasks (PRD §5/§3 scope). Open-ended/
        // subjective tasks have no on-chain verification path in Phase 1.
        if matches!(task_type, TaskType::Unverifiable) {
            return Err(Error::InvalidTaskType);
        }
        let cfg = storage::get_config(&e).ok_or(Error::NotInitialized)?;
        let bond_asset = storage::get_bond_asset(&e).ok_or(Error::NotInitialized)?;

        // The proportional minimum rounds down to zero for a tiny
        // escrow_value; a submission with nothing at stake is not bonded.
        let min_bond = checked_bps(escrow_value, cfg.agent_bond_min_bps)?;
        if bond <= 0 || bond < min_bond {
            return Err(Error::BondTooLow);
        }

        let contract_address = e.current_contract_address();
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        token.transfer(&agent, contract_address, &bond);
        storage::bump_instance(&e);

        let window_s = if escrow_value < cfg.window_tier_small_ceiling {
            cfg.window_tier_small_s
        } else {
            cfg.window_tier_large_s
        };

        let id = storage::next_submission_id(&e);
        let record = SubmissionRecord {
            id,
            agent: agent.clone(),
            escrow_ref: escrow_ref.clone(),
            escrow_value,
            task_type,
            input_hash,
            claimed_output_hash: output_hash,
            bond_amount: bond,
            submitted_at: e.ledger().timestamp(),
            challenge_window_s: window_s,
            verdict: Verdict::Pending,
            finalized: false,
            match_votes: 0,
            mismatch_votes: 0,
            bonded_weight_matched: 0,
            bonded_weight_mismatched: 0,
            resolution_method: ResolutionMethod::None,
            cfg_quorum_min_reexecutors: cfg.quorum_min_reexecutors,
            cfg_quorum_supermajority_bps: cfg.quorum_supermajority_bps,
            cfg_slash_split_challenger_bps: cfg.slash_split_challenger_bps,
            cfg_challenger_bond_min_bps: cfg.challenger_bond_min_bps,
            cfg_reexecutor_slash_bps: cfg.reexecutor_slash_bps,
        };
        storage::set_submission(&e, id, &record);

        SubmissionCreated {
            submission_id: id,
            agent,
            escrow_ref,
            escrow_value,
            bond,
        }
        .publish(&e);

        Ok(id)
    }

    /// Also serves as a stake top-up for an already-registered reexecutor.
    pub fn register_reexecutor(e: Env, reexecutor: Address, stake_amount: i128) -> Result<(), Error> {
        reexecutor.require_auth();
        if stake_amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let cfg = storage::get_config(&e).ok_or(Error::NotInitialized)?;
        let bond_asset = storage::get_bond_asset(&e).ok_or(Error::NotInitialized)?;

        let existing = storage::get_reexecutor(&e, &reexecutor);
        let (prior_stake, joined_at, open_attestations, approved) = match &existing {
            Some(info) => (info.stake_amount, info.joined_at, info.open_attestations, info.approved),
            None => (0, e.ledger().timestamp(), 0, false),
        };
        let new_stake = prior_stake.checked_add(stake_amount).ok_or(Error::Overflow)?;

        let contract_address = e.current_contract_address();
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        token.transfer(&reexecutor, contract_address, &stake_amount);

        let info = ReexecutorInfo {
            stake_amount: new_stake,
            active: new_stake >= cfg.min_stake_floor,
            joined_at,
            open_attestations,
            approved,
        };
        storage::set_reexecutor(&e, &reexecutor, &info);
        storage::bump_instance(&e);

        ReexecutorRegistered {
            reexecutor,
            stake_amount: new_stake,
            active: info.active,
        }
        .publish(&e);
        Ok(())
    }

    /// Blocked entirely while any of this reexecutor's attestations sit on a
    /// not-yet-finalized submission — see release_attestation_lock. A vote is
    /// weighted by the full stake at the moment it is cast, but a slash takes a
    /// share of the stake at slash time, so any stake allowed to leave before
    /// then would be weight that was never at risk. A reexecutor with zero
    /// open attestations may withdraw in full, deactivating themselves.
    pub fn withdraw_stake(e: Env, reexecutor: Address, amount: i128) -> Result<(), Error> {
        reexecutor.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let cfg = storage::get_config(&e).ok_or(Error::NotInitialized)?;
        let bond_asset = storage::get_bond_asset(&e).ok_or(Error::NotInitialized)?;
        let mut info = storage::get_reexecutor(&e, &reexecutor).ok_or(Error::ReexecutorNotActive)?;

        let new_stake = info.stake_amount.checked_sub(amount).ok_or(Error::Overflow)?;
        if new_stake < 0 {
            return Err(Error::InvalidAmount);
        }
        if info.open_attestations > 0 {
            return Err(Error::StakeLockedByOpenAttestation);
        }

        info.stake_amount = new_stake;
        info.active = new_stake >= cfg.min_stake_floor;
        storage::set_reexecutor(&e, &reexecutor, &info);
        storage::bump_instance(&e);

        let contract_address = e.current_contract_address();
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        token.transfer(&contract_address, reexecutor.clone(), &amount);

        ReexecutorStakeWithdrawn { reexecutor, new_stake, active: info.active }.publish(&e);
        Ok(())
    }

    pub fn reexecutor_info(e: Env, reexecutor: Address) -> Option<ReexecutorInfo> {
        storage::get_reexecutor(&e, &reexecutor)
    }

    /// Any account with sufficient active stake may attest on any submission
    /// (off-chain assignment/scheduling is the backend's job, not an on-chain
    /// gate) — unless ConfigRecord::reexecutor_allowlist is on, in which case
    /// the admin must also have approved the account. One vote per
    /// (submission, reexecutor), enforced by the ReplayAttestation storage
    /// guard. Records the raw output hash alongside the vote for later
    /// off-chain audit; the contract itself only trusts the boolean `matched`
    /// claim plus bonded-majority economics.
    pub fn attest_replay(
        e: Env,
        reexecutor: Address,
        submission_id: u64,
        output_hash: BytesN<32>,
        matched: bool,
    ) -> Result<(), Error> {
        reexecutor.require_auth();
        let mut info = storage::get_reexecutor(&e, &reexecutor).ok_or(Error::ReexecutorNotActive)?;
        let cfg = storage::get_config(&e).ok_or(Error::NotInitialized)?;
        if !info.active || info.stake_amount < cfg.min_stake_floor {
            return Err(Error::ReexecutorNotActive);
        }
        if cfg.reexecutor_allowlist && !info.approved {
            return Err(Error::ReexecutorNotApproved);
        }
        if storage::get_attestation(&e, submission_id, &reexecutor).is_some() {
            return Err(Error::AlreadyAttested);
        }
        let mut sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        if sub.finalized {
            return Err(Error::ChallengeWindowClosed);
        }
        // With no challenge open, the verdict of a window is settled the moment
        // the window closes: finalize() only reads the tally, whenever somebody
        // calls it. A vote accepted after that would change a verdict that was
        // already decided, and the outcome would depend on who reached the
        // chain first. The deadline second is closed, as it is for
        // open_challenge and finalize.
        //
        // A challenged submission is the exception: resolve_challenge needs a
        // consensus, and that may only form after the window, so votes on it
        // are accepted until it is finalized.
        if storage::get_challenge(&e, submission_id).is_none()
            && e.ledger().timestamp() >= sub.submitted_at.saturating_add(sub.challenge_window_s)
        {
            return Err(Error::ChallengeWindowClosed);
        }
        // The agent being checked cannot vote on its own work.
        if reexecutor == sub.agent {
            return Err(Error::AgentCannotAttest);
        }
        // `matched` is the tally's only input, but the hash it was derived
        // from is public: a vote claiming a match must report the claimed
        // hash, and one claiming a mismatch must report a different one.
        if matched != (output_hash == sub.claimed_output_hash) {
            return Err(Error::VoteContradictsHash);
        }

        storage::mark_attested(&e, submission_id, &reexecutor, matched);
        info.open_attestations = info.open_attestations.saturating_add(1);
        storage::set_reexecutor(&e, &reexecutor, &info);
        storage::bump_instance(&e);

        if matched {
            sub.match_votes += 1;
            sub.bonded_weight_matched = sub
                .bonded_weight_matched
                .checked_add(info.stake_amount)
                .ok_or(Error::Overflow)?;
        } else {
            sub.mismatch_votes += 1;
            sub.bonded_weight_mismatched = sub
                .bonded_weight_mismatched
                .checked_add(info.stake_amount)
                .ok_or(Error::Overflow)?;
        }
        storage::set_submission(&e, submission_id, &sub);

        ReplayAttested {
            submission_id,
            reexecutor,
            output_hash,
            matched,
        }
        .publish(&e);
        Ok(())
    }

    /// Attester with zero open (unresolved) attestations already withdraws
    /// freely; this permissionless bookkeeping call unlocks the counter once
    /// a given submission this reexecutor voted on has been finalized, without
    /// requiring the contract to enumerate all of a submission's attesters.
    ///
    /// A vote the verdict proved wrong is slashed here, before the lock comes
    /// off. The lock is the only thing keeping that stake in the contract, so
    /// releasing it first would let the voter withdraw ahead of the slash.
    pub fn release_attestation_lock(
        e: Env,
        submission_id: u64,
        reexecutor: Address,
    ) -> Result<(), Error> {
        let sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        if !sub.finalized {
            return Err(Error::SubmissionNotFinalized);
        }
        let recorded_vote = storage::get_attestation(&e, submission_id, &reexecutor)
            .ok_or(Error::PartyNotOnWrongSide)?;
        if storage::is_released(&e, submission_id, &reexecutor) {
            return Err(Error::AttestationAlreadyReleased);
        }
        let mut info =
            storage::get_reexecutor(&e, &reexecutor).ok_or(Error::ReexecutorNotActive)?;
        if wrong_vote(&sub) == Some(recorded_vote)
            && !storage::is_slashed(&e, submission_id, &reexecutor)
        {
            apply_slash(&e, &sub, &reexecutor, &mut info)?;
        }
        info.open_attestations = info.open_attestations.saturating_sub(1);
        storage::set_reexecutor(&e, &reexecutor, &info);
        storage::mark_released(&e, submission_id, &reexecutor);
        storage::bump_instance(&e);
        Ok(())
    }

    /// Bond-proportional, snapshotted at submit() time (invariant 5).
    pub fn open_challenge(
        e: Env,
        challenger: Address,
        submission_id: u64,
        bond: i128,
    ) -> Result<(), Error> {
        challenger.require_auth();
        let sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        // The agent may not challenge its own submission, as it may not vote on
        // it (AgentCannotAttest). On a slash the challenger is paid a share of
        // the forfeited bond, so a self-challenge would hand part of that bond
        // back to the party that forfeited it, and it would take the one
        // challenge slot from an honest challenger. Only this address is
        // refused: another address the agent controls looks like anyone else.
        if challenger == sub.agent {
            return Err(Error::AgentCannotChallenge);
        }
        if sub.finalized {
            return Err(Error::ChallengeWindowClosed);
        }
        let now = e.ledger().timestamp();
        if now >= sub.submitted_at.saturating_add(sub.challenge_window_s) {
            return Err(Error::ChallengeWindowClosed);
        }
        if storage::get_challenge(&e, submission_id).is_some() {
            return Err(Error::ChallengeAlreadyOpen);
        }
        // A challenge is a bet against an outcome that is still open. Once the
        // bonded votes already decide the submission, in either direction, a
        // challenger adds no information and takes no risk: after a mismatch
        // consensus they would collect the challenger's share of a slash that
        // was already certain. finalize() settles such a submission as it is.
        //
        // This is checked when the challenge is opened and not again: votes
        // cast afterwards still count, and may form the consensus that
        // resolve_challenge needs.
        if consensus_outcome(&sub)?.is_some() {
            return Err(Error::ConsensusAlreadyReached);
        }
        let min_bond = checked_bps(sub.escrow_value, sub.cfg_challenger_bond_min_bps)?;
        // Mirrors submit(): the proportional minimum rounds down to zero for
        // a tiny escrow, and a challenge with nothing at stake is free.
        if bond <= 0 || bond < min_bond {
            return Err(Error::BondTooLow);
        }

        let bond_asset = storage::get_bond_asset(&e).ok_or(Error::NotInitialized)?;
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        token.transfer(&challenger, e.current_contract_address(), &bond);
        storage::bump_instance(&e);

        let chal = ChallengeRecord {
            challenger: challenger.clone(),
            bond,
            opened_at: now,
            resolution: Resolution::None,
            resolution_method: ResolutionMethod::None,
        };
        storage::set_challenge(&e, submission_id, &chal);

        ChallengeOpened { submission_id, challenger, bond }.publish(&e);
        Ok(())
    }

    /// Permissionless — every precondition is read from already-committed
    /// on-chain state (the bonded attestation tally), never from caller
    /// identity (invariant 2). Delegates the actual verdict-setting and fund
    /// movement to finalize(), which is the single idempotent writer of
    /// terminal state (invariant 3).
    ///
    /// Re-execution consensus is the only way to resolve a challenge in
    /// Phase 1. `ZkProof` is rejected outright: this entrypoint carries no
    /// proof, so honouring it would mean taking a registry's word for a proof
    /// nobody supplied — and whoever administers that registry could then
    /// decide any challenge (invariant 4).
    pub fn resolve_challenge(
        e: Env,
        submission_id: u64,
        method: ResolutionMethod,
    ) -> Result<Verdict, Error> {
        let sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        let mut chal = storage::get_challenge(&e, submission_id).ok_or(Error::ChallengeNotFound)?;
        if chal.resolution != Resolution::None {
            return Err(Error::ChallengeAlreadyResolved);
        }

        let resolution = match method {
            ResolutionMethod::ReexecutionConsensus => {
                match consensus_outcome(&sub)? {
                    Some(Verdict::Verified) => Resolution::Rejected,
                    Some(Verdict::Slashed) => Resolution::Upheld,
                    _ => return Err(Error::InsufficientConsensus),
                }
            }
            _ => return Err(Error::InvalidResolutionMethod),
        };

        chal.resolution = resolution;
        chal.resolution_method = method;
        storage::set_challenge(&e, submission_id, &chal);

        ChallengeResolved { submission_id, resolution, method }.publish(&e);

        Self::finalize(e, submission_id)
    }

    /// The sole writer of terminal submission state and the sole mover of the
    /// agent's bond. Idempotent: a repeat call after finalized=true is a pure
    /// read with zero storage writes and zero token transfers (invariant 3).
    /// Only ever auto-verifies before the window closes when a bonded
    /// consensus majority already exists and no challenge is open
    /// (invariant 1).
    ///
    /// Absent both a challenge and a consensus, a window-elapsed submission
    /// defaults to Verified per the PRD's optimistic-verification design (no
    /// challenge => no proof of fraud) — unless a re-executor reported a
    /// mismatch, in which case the work was contested without being settled
    /// and it expires as ExpiredUnverified instead. Either way the verdict is
    /// recorded as WindowElapsed, never as a consensus that did not happen.
    ///
    /// A challenge that nobody can resolve — re-executors never reached a
    /// bonded consensus within one further challenge window of it being
    /// opened — expires as ExpiredUnverified and releases both bonds, rather
    /// than freezing the agent's and challenger's funds forever. While a
    /// consensus does exist, the only way out is resolve_challenge().
    pub fn finalize(e: Env, submission_id: u64) -> Result<Verdict, Error> {
        let mut sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        if sub.finalized {
            return Ok(sub.verdict);
        }

        let (verdict, method) = if let Some(mut chal) = storage::get_challenge(&e, submission_id) {
            match chal.resolution {
                Resolution::None => {
                    let deadline = chal.opened_at.saturating_add(sub.challenge_window_s);
                    if e.ledger().timestamp() < deadline || consensus_outcome(&sub)?.is_some() {
                        return Ok(Verdict::Pending);
                    }
                    // Nobody resolved it in time. The record says so before
                    // anything is settled, so get_challenge() no longer
                    // shows an open challenge on a finalized submission.
                    chal.resolution = Resolution::Expired;
                    chal.resolution_method = ResolutionMethod::WindowElapsed;
                    storage::set_challenge(&e, submission_id, &chal);
                    ChallengeExpired { submission_id }.publish(&e);
                    (Verdict::ExpiredUnverified, ResolutionMethod::WindowElapsed)
                }
                Resolution::Upheld => (Verdict::Slashed, chal.resolution_method),
                Resolution::Rejected => (Verdict::Verified, chal.resolution_method),
                // Only the branch above writes this, in the call that also
                // marks the submission finalized, so the early return has
                // already answered. The arm keeps the match total.
                Resolution::Expired => {
                    (Verdict::ExpiredUnverified, ResolutionMethod::WindowElapsed)
                }
            }
        } else {
            let now = e.ledger().timestamp();
            let window_elapsed = now >= sub.submitted_at.saturating_add(sub.challenge_window_s);
            match consensus_outcome(&sub)? {
                Some(v) => (v, ResolutionMethod::ReexecutionConsensus),
                None if window_elapsed && sub.mismatch_votes > 0 => {
                    (Verdict::ExpiredUnverified, ResolutionMethod::WindowElapsed)
                }
                None if window_elapsed => (Verdict::Verified, ResolutionMethod::WindowElapsed),
                None => return Ok(Verdict::Pending),
            }
        };

        sub.verdict = verdict;
        sub.finalized = true;
        sub.resolution_method = method;
        settle(&e, &sub)?;
        storage::set_submission(&e, submission_id, &sub);
        storage::bump_instance(&e);
        Finalized { submission_id, verdict: sub.verdict }.publish(&e);
        Ok(sub.verdict)
    }

    /// Permissionless, and the caller chooses nothing: every check derives
    /// from already-committed on-chain state, and the amount is the
    /// cfg_reexecutor_slash_bps share snapshotted at submit() time. The
    /// submission must have been finalized by a bonded consensus — a verdict
    /// that merely defaulted when the window elapsed proves nobody wrong — and
    /// the target's own recorded vote (stored at attest_replay time) must be
    /// on the side that consensus proved wrong. There is no branch here, or
    /// anywhere in this contract, where the admin's address changes the
    /// outcome (invariant 2).
    ///
    /// release_attestation_lock() applies the same slash on its own, so this
    /// entrypoint is never required — it only lets anyone slash sooner.
    pub fn slash(e: Env, reexecutor: Address, submission_id: u64) -> Result<i128, Error> {
        if storage::is_slashed(&e, submission_id, &reexecutor) {
            return Err(Error::AlreadySlashed);
        }
        // Once the attestation lock has been released the vote is settled;
        // stake deposited afterwards must never be taken for an older vote.
        if storage::is_released(&e, submission_id, &reexecutor) {
            return Err(Error::AttestationAlreadyReleased);
        }
        let sub = storage::get_submission(&e, submission_id).ok_or(Error::SubmissionNotFound)?;
        if !sub.finalized {
            return Err(Error::SubmissionNotFinalized);
        }
        let wrong = wrong_vote(&sub).ok_or(Error::NotSlashable)?;
        let recorded_vote = storage::get_attestation(&e, submission_id, &reexecutor)
            .ok_or(Error::PartyNotOnWrongSide)?;
        if recorded_vote != wrong {
            return Err(Error::PartyNotOnWrongSide);
        }

        let mut info =
            storage::get_reexecutor(&e, &reexecutor).ok_or(Error::ReexecutorNotActive)?;
        let amount = apply_slash(&e, &sub, &reexecutor, &mut info)?;
        if amount == 0 {
            return Err(Error::NotSlashable);
        }
        storage::set_reexecutor(&e, &reexecutor, &info);
        storage::bump_instance(&e);
        Ok(amount)
    }

    pub fn get_submission(e: Env, id: u64) -> Option<SubmissionRecord> {
        storage::get_submission(&e, id)
    }

    pub fn get_challenge(e: Env, id: u64) -> Option<ChallengeRecord> {
        storage::get_challenge(&e, id)
    }

    pub fn get_config(e: Env) -> Option<ConfigRecord> {
        storage::get_config(&e)
    }

    pub fn get_admin(e: Env) -> Option<Address> {
        storage::get_admin(&e)
    }

    /// The token every bond and stake is paid in. It is set by the constructor
    /// and never changes, so a client can read it once to know which token it
    /// is about to move, and a backend can check it is configured for the
    /// same one.
    pub fn get_bond_asset(e: Env) -> Option<Address> {
        storage::get_bond_asset(&e)
    }
}

#[cfg(test)]
mod test;
