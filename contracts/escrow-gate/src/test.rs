#![cfg(test)]

use crate::events::{ReexecutorRegistered, ReexecutorStakeWithdrawn};
use crate::{EscrowGate, EscrowGateClient};
use soroban_sdk::{
    events::Event as _,
    testutils::{storage::Instance as _, Address as _, Events as _, Ledger as _},
    token, Address, BytesN, Env,
};
use verity_common::{
    ConfigRecord, Error, ReexecutorInfo, Resolution, ResolutionMethod, TaskType, Verdict,
};

const STROOP: i128 = 1;
const XLM: i128 = 10_000_000 * STROOP;

fn default_config() -> ConfigRecord {
    ConfigRecord {
        min_stake_floor: 500 * XLM,
        quorum_min_reexecutors: 3,
        quorum_supermajority_bps: 6600,
        agent_bond_min_bps: 500,
        challenger_bond_min_bps: 500,
        window_tier_small_ceiling: 100_000 * XLM,
        window_tier_small_s: 3600,
        window_tier_large_s: 86_400,
        slash_split_challenger_bps: 2000,
        reexecutor_slash_bps: 1000,
        reexecutor_allowlist: false,
    }
}

struct World<'a> {
    e: Env,
    client: EscrowGateClient<'a>,
    admin: Address,
    token: token::Client<'a>,
    token_admin: token::StellarAssetClient<'a>,
}

fn setup(e: &Env) -> World<'_> {
    setup_with(e, default_config())
}

fn setup_with(e: &Env, config: ConfigRecord) -> World<'_> {
    e.mock_all_auths();
    let admin = Address::generate(e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(e, &sac.address());
    let token_admin = token::StellarAssetClient::new(e, &sac.address());

    let id = e.register(EscrowGate, (admin.clone(), sac.address(), config));
    let client = EscrowGateClient::new(e, &id);

    World { e: e.clone(), client, admin, token, token_admin }
}

fn fund(w: &World, who: &Address, amount: i128) {
    w.token_admin.mint(who, &amount);
}

fn submit_default(w: &World, agent: &Address) -> u64 {
    fund(w, agent, 1000 * XLM);
    w.client.submit(
        agent,
        &BytesN::from_array(&w.e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&w.e, &[2u8; 32]),
        &BytesN::from_array(&w.e, &[3u8; 32]),
        &(50 * XLM), // 5% of escrow_value, exactly the min bond
    )
}

fn register_rex(w: &World, rex: &Address) {
    fund(w, rex, 2000 * XLM);
    w.client.register_reexecutor(rex, &(600 * XLM));
}

// ---- basic submit / bond custody ----

#[test]
fn submit_transfers_bond_and_creates_pending_submission() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    assert_eq!(w.token.balance(&agent), 950 * XLM);
    assert_eq!(w.token.balance(&w.client.address), 50 * XLM);

    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!(sub.verdict, Verdict::Pending);
    assert!(!sub.finalized);
}

#[test]
fn submit_rejects_bond_below_minimum() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    fund(&w, &agent, 1000 * XLM);

    let res = w.client.try_submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(10 * XLM), // below the 5% = 50 XLM floor
    );
    assert!(matches!(res, Err(Ok(Error::BondTooLow))));
}

#[test]
fn submit_rejects_unverifiable_task_type() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    fund(&w, &agent, 1000 * XLM);

    let res = w.client.try_submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Unverifiable,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );
    assert!(matches!(res, Err(Ok(Error::InvalidTaskType))));
}

// ---- invariant 1: no auto-verify before window closes unless majority already exists ----

#[test]
fn finalize_before_window_with_no_votes_stays_pending() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    assert_eq!(w.client.finalize(&id), Verdict::Pending);
    let sub = w.client.get_submission(&id).unwrap();
    assert!(!sub.finalized);
}

#[test]
fn early_consensus_match_supermajority_allows_finalize_before_window() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    }

    // Window is 24h (escrow_value 1000 XLM >= 100,000 XLM ceiling? no —
    // 1000 XLM < 100_000 XLM ceiling, so this is actually the 1h tier).
    // Regardless, finalize succeeds immediately because 3/3 unanimous match
    // votes clears the quorum (3) and supermajority (66%) with zero elapsed
    // time — this IS invariant 1's early path.
    let verdict = w.client.finalize(&id);
    assert_eq!(verdict, Verdict::Verified);
    assert_eq!(w.token.balance(&agent), 1000 * XLM); // bond returned in full
}

#[test]
fn mismatch_supermajority_slashes_agent_bond_without_a_challenge() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }

    let verdict = w.client.finalize(&id);
    assert_eq!(verdict, Verdict::Slashed);
    // Agent never gets the bond back; no challenger exists so it routes to admin.
    assert_eq!(w.token.balance(&agent), 950 * XLM);
    assert_eq!(w.token.balance(&w.admin), 50 * XLM);
}

#[test]
fn window_elapsed_with_no_consensus_and_no_challenge_defaults_verified() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    // One lone match vote: quorum of 3 never reached, so no early consensus.
    let rex1 = Address::generate(&e);
    register_rex(&w, &rex1);
    w.client.attest_replay(&rex1, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);

    e.ledger().set_timestamp(e.ledger().timestamp() + 3601); // past the 1h window
    let verdict = w.client.finalize(&id);
    assert_eq!(verdict, Verdict::Verified);
    assert_eq!(w.token.balance(&agent), 1000 * XLM);

    // Nobody replayed this to quorum, and the record must say so.
    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!(sub.resolution_method, ResolutionMethod::WindowElapsed);
    // A default verdict proves nobody wrong.
    assert_eq!(w.client.try_slash(&rex1, &id), Err(Ok(Error::NotSlashable)));
}

#[test]
fn window_elapsed_with_a_mismatch_vote_expires_unverified_and_slashes_nobody() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    // One re-executor reports a mismatch; quorum is never reached.
    let rex1 = Address::generate(&e);
    register_rex(&w, &rex1);
    w.client.attest_replay(&rex1, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);

    e.ledger().set_timestamp(e.ledger().timestamp() + 3601);
    // Contested but unsettled: not Verified, and not Slashed either.
    assert_eq!(w.client.finalize(&id), Verdict::ExpiredUnverified);
    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!(sub.resolution_method, ResolutionMethod::WindowElapsed);
    assert_eq!(w.token.balance(&agent), 1000 * XLM); // bond returned, nothing forfeited

    // The lone honest voter keeps every stroop, by either route.
    assert_eq!(w.client.try_slash(&rex1, &id), Err(Ok(Error::NotSlashable)));
    w.client.release_attestation_lock(&id, &rex1);
    let info = w.client.reexecutor_info(&rex1).unwrap();
    assert_eq!(info.stake_amount, 600 * XLM);
    assert_eq!(info.open_attestations, 0);
}

// ---- invariant 3: finalize is idempotent and irreversible ----

#[test]
fn finalize_is_idempotent_zero_extra_writes_or_transfers() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    e.ledger().set_timestamp(e.ledger().timestamp() + 3601);
    let v1 = w.client.finalize(&id);
    let bal_after_first = w.token.balance(&agent);

    let v2 = w.client.finalize(&id);
    let v3 = w.client.finalize(&id);
    assert_eq!(v1, v2);
    assert_eq!(v2, v3);
    assert_eq!(w.token.balance(&agent), bal_after_first); // no double payout
}

#[test]
fn open_challenge_after_finalize_is_rejected() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    e.ledger().set_timestamp(e.ledger().timestamp() + 3601);
    w.client.finalize(&id);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    let res = w.client.try_open_challenge(&challenger, &id, &(50 * XLM));
    assert!(matches!(res, Err(Ok(Error::ChallengeWindowClosed))));
}

// ---- invariant 2: slash derives authority only from already-committed state ----

#[test]
fn slash_before_finalize_is_rejected() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    // Not finalized yet — nobody can slash, whoever sends the transaction.
    let rex1 = Address::generate(&e);
    register_rex(&w, &rex1);
    let res = w.client.try_slash(&rex1, &id);
    assert!(matches!(res, Err(Ok(Error::SubmissionNotFinalized))));
}

#[test]
fn slash_requires_the_target_to_actually_be_on_the_wrong_side() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    let honest = [&rex1, &rex2, &rex3];
    for r in honest {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    }
    let verdict = w.client.finalize(&id);
    assert_eq!(verdict, Verdict::Verified);

    // rex1 voted "matched" (the correct side, since verdict is Verified) —
    // slashing them must fail regardless of who calls it.
    let res = w.client.try_slash(&rex1, &id);
    assert!(matches!(res, Err(Ok(Error::PartyNotOnWrongSide)))); // never on-chain state says otherwise
}

#[test]
fn slash_succeeds_against_a_provably_wrong_voter_after_mismatch_consensus() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex1 = Address::generate(&e); // will vote wrong (matched=true)
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    register_rex(&w, &rex1);
    register_rex(&w, &rex2);
    register_rex(&w, &rex3);
    w.client.attest_replay(&rex1, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    w.client.attest_replay(&rex2, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    w.client.attest_replay(&rex3, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);

    let verdict = w.client.finalize(&id);
    assert_eq!(verdict, Verdict::Slashed);

    // The amount is the configured 10% of stake — the caller has no say in
    // it, so a wrong-side voter cannot slash themselves for a token amount
    // and walk away immune.
    let admin_before = w.token.balance(&w.admin);
    assert_eq!(w.client.slash(&rex1, &id), 60 * XLM);
    let info = w.client.reexecutor_info(&rex1).unwrap();
    assert_eq!(info.stake_amount, 540 * XLM); // 600 - 10%
    assert_eq!(w.token.balance(&w.admin), admin_before + 60 * XLM); // no challenger to share with

    // Cannot slash the same party twice for the same submission.
    let res = w.client.try_slash(&rex1, &id);
    assert!(matches!(res, Err(Ok(Error::AlreadySlashed))));
}

#[test]
fn releasing_the_lock_slashes_a_wrong_voter_first() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let wrong = Address::generate(&e);
    let right1 = Address::generate(&e);
    let right2 = Address::generate(&e);
    for r in [&wrong, &right1, &right2] {
        register_rex(&w, r);
    }
    w.client.attest_replay(&wrong, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    w.client.attest_replay(&right1, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    w.client.attest_replay(&right2, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    assert_eq!(w.client.finalize(&id), Verdict::Slashed);

    // The wrong voter races to unlock and withdraw before anyone slashes
    // them. Unlocking is the only way out, and it takes the slash with it.
    w.client.release_attestation_lock(&id, &wrong);
    let info = w.client.reexecutor_info(&wrong).unwrap();
    assert_eq!(info.stake_amount, 540 * XLM);
    assert_eq!(info.open_attestations, 0);
    // The pre-slash balance is gone; only what is left can leave.
    assert_eq!(
        w.client.try_withdraw_stake(&wrong, &(600 * XLM)),
        Err(Ok(Error::InvalidAmount))
    );
    w.client.withdraw_stake(&wrong, &(540 * XLM));
    assert_eq!(w.client.try_slash(&wrong, &id), Err(Ok(Error::AlreadySlashed)));

    // A voter on the right side unlocks with their stake intact.
    w.client.release_attestation_lock(&id, &right1);
    assert_eq!(w.client.reexecutor_info(&right1).unwrap().stake_amount, 600 * XLM);
}

#[test]
fn slash_cannot_take_stake_deposited_after_lock_release() {
    let e = Env::default();
    let w = setup_with(&e, ConfigRecord { reexecutor_slash_bps: 10_000, ..default_config() });
    let agent = Address::generate(&e);
    let sub_a = submit_default(&w, &agent);
    let sub_b = submit_default(&w, &agent);

    let wrong = Address::generate(&e);
    let right1 = Address::generate(&e);
    let right2 = Address::generate(&e);
    for r in [&wrong, &right1, &right2] {
        register_rex(&w, r);
    }

    let claimed = BytesN::from_array(&e, &[3u8; 32]);
    let mismatch = BytesN::from_array(&e, &[9u8; 32]);
    for id in [sub_a, sub_b] {
        w.client.attest_replay(&wrong, &id, &claimed, &true);
        w.client.attest_replay(&right1, &id, &mismatch, &false);
        w.client.attest_replay(&right2, &id, &mismatch, &false);
        assert_eq!(w.client.finalize(&id), Verdict::Slashed);
    }

    // Releasing A takes all 600 XLM of wrong's stake (100% slash).
    w.client.release_attestation_lock(&sub_a, &wrong);
    let info = w.client.reexecutor_info(&wrong).unwrap();
    assert_eq!(info.stake_amount, 0);
    assert!(!info.active);
    assert_eq!(info.open_attestations, 1);

    // Releasing B finds 0 stake left, settles nothing further, and drops open_attestations to 0.
    w.client.release_attestation_lock(&sub_b, &wrong);
    let info = w.client.reexecutor_info(&wrong).unwrap();
    assert_eq!(info.stake_amount, 0);
    assert_eq!(info.open_attestations, 0);

    // Re-executor deposits fresh stake after all prior locks were released.
    w.client.register_reexecutor(&wrong, &(600 * XLM));
    let admin_before = w.token.balance(&w.admin);
    let contract_before = w.token.balance(&w.client.address);
    let wrong_bal_before = w.token.balance(&wrong);

    // Calling slash() for the already-released vote B must fail and leave the new stake untouched.
    assert_eq!(
        w.client.try_slash(&wrong, &sub_b),
        Err(Ok(Error::AttestationAlreadyReleased))
    );
    let info = w.client.reexecutor_info(&wrong).unwrap();
    assert_eq!(info.stake_amount, 600 * XLM);
    assert!(info.active);
    assert_eq!(w.token.balance(&w.admin), admin_before);
    assert_eq!(w.token.balance(&w.client.address), contract_before);
    assert_eq!(w.token.balance(&wrong), wrong_bal_before);
}

#[test]
fn slash_after_normal_release_is_rejected_and_moves_no_tokens() {
    // Normal release on a right-side voter.
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let wrong = Address::generate(&e);
    let right1 = Address::generate(&e);
    let right2 = Address::generate(&e);
    for r in [&wrong, &right1, &right2] {
        register_rex(&w, r);
    }
    w.client.attest_replay(&wrong, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    w.client.attest_replay(&right1, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    w.client.attest_replay(&right2, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    assert_eq!(w.client.finalize(&id), Verdict::Slashed);

    w.client.release_attestation_lock(&id, &right1);
    let admin_before = w.token.balance(&w.admin);
    let contract_before = w.token.balance(&w.client.address);
    let right1_bal_before = w.token.balance(&right1);

    assert_eq!(
        w.client.try_slash(&right1, &id),
        Err(Ok(Error::AttestationAlreadyReleased))
    );
    assert_eq!(w.client.reexecutor_info(&right1).unwrap().stake_amount, 600 * XLM);
    assert_eq!(w.token.balance(&w.admin), admin_before);
    assert_eq!(w.token.balance(&w.client.address), contract_before);
    assert_eq!(w.token.balance(&right1), right1_bal_before);

    // Normal release on a wrong-side voter when slashing is disabled (0 bps).
    let e = Env::default();
    let w = setup_with(&e, ConfigRecord { reexecutor_slash_bps: 0, ..default_config() });
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let wrong = Address::generate(&e);
    register_rex(&w, &wrong);
    w.client.attest_replay(&wrong, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    for _ in 0..2 {
        let r = Address::generate(&e);
        register_rex(&w, &r);
        w.client.attest_replay(&r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }
    assert_eq!(w.client.finalize(&id), Verdict::Slashed);

    w.client.release_attestation_lock(&id, &wrong);
    let admin_before = w.token.balance(&w.admin);
    let contract_before = w.token.balance(&w.client.address);

    assert_eq!(
        w.client.try_slash(&wrong, &id),
        Err(Ok(Error::AttestationAlreadyReleased))
    );
    assert_eq!(w.client.reexecutor_info(&wrong).unwrap().stake_amount, 600 * XLM);
    assert_eq!(w.token.balance(&w.admin), admin_before);
    assert_eq!(w.token.balance(&w.client.address), contract_before);
}

#[test]
fn reexecutor_slash_pays_only_a_challenger_who_won() {
    // Upheld challenge: the prevailing challenger shares in the stake of a
    // re-executor who backed the bad submission.
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));

    let backer = Address::generate(&e);
    register_rex(&w, &backer);
    w.client.attest_replay(&backer, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    for _ in 0..3 {
        let r = Address::generate(&e);
        register_rex(&w, &r);
        w.client.attest_replay(&r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }
    assert_eq!(
        w.client.resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus),
        Verdict::Slashed
    );
    let challenger_before = w.token.balance(&challenger);
    let admin_before = w.token.balance(&w.admin);
    assert_eq!(w.client.slash(&backer, &id), 60 * XLM);
    assert_eq!(w.token.balance(&challenger), challenger_before + 12 * XLM); // 20% of 60
    assert_eq!(w.token.balance(&w.admin), admin_before + 48 * XLM);

    // Rejected challenge: the challenger lost, so the stake of a re-executor
    // who happened to agree with them goes to the treasury alone.
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));

    let dissenter = Address::generate(&e);
    register_rex(&w, &dissenter);
    w.client.attest_replay(&dissenter, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    for _ in 0..3 {
        let r = Address::generate(&e);
        register_rex(&w, &r);
        w.client.attest_replay(&r, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    }
    assert_eq!(
        w.client.resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus),
        Verdict::Verified
    );
    let challenger_before = w.token.balance(&challenger);
    let admin_before = w.token.balance(&w.admin);
    assert_eq!(w.client.slash(&dissenter, &id), 60 * XLM);
    assert_eq!(w.token.balance(&challenger), challenger_before);
    assert_eq!(w.token.balance(&w.admin), admin_before + 60 * XLM);
}

// ---- invariant 5: bond proportionality holds across the i128 range without wrapping ----

#[test]
fn bond_math_does_not_wrap_at_i128_extremes() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    fund(&w, &agent, i128::MAX);

    // Just under the point where value * agent_bond_min_bps (500) would
    // overflow i128: correct checked math computes the true 5% bond exactly.
    let large_but_safe_value = i128::MAX / 501;
    let exact_min_bond = (large_but_safe_value * 500) / 10_000;
    let res_ok = w.client.try_submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &large_but_safe_value,
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &exact_min_bond,
    );
    assert!(res_ok.is_ok(), "expected exact-proportional bond to succeed: {:?}", res_ok);

    // Just over that point, naive `value * bps` (never mind `* 10_000` for
    // the challenger-bond check elsewhere) overflows i128 — checked
    // arithmetic must produce a clean Overflow error, never a silent wrap
    // into a small or negative "bond requirement".
    let overflowing_value = i128::MAX / 100;
    let res_overflow = w.client.try_submit(
        &agent,
        &BytesN::from_array(&e, &[4u8; 32]),
        &overflowing_value,
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[5u8; 32]),
        &BytesN::from_array(&e, &[6u8; 32]),
        &(overflowing_value / 2),
    );
    assert!(matches!(res_overflow, Err(Ok(Error::Overflow))), "expected a clean Overflow error, got {:?}", res_overflow);
}

// ---- invariant 4: no path reports a ZK-verified result in Phase 1 ----

#[test]
fn resolve_challenge_rejects_the_zk_proof_method() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));
    for _ in 0..3 {
        let r = Address::generate(&e);
        register_rex(&w, &r);
        w.client.attest_replay(&r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }

    // resolve_challenge carries no proof, so there is nothing a ZK path could
    // check. It must refuse rather than take anyone's word for one — and
    // leave the challenge exactly as it was.
    assert_eq!(
        w.client.try_resolve_challenge(&id, &ResolutionMethod::ZkProof),
        Err(Ok(Error::InvalidResolutionMethod))
    );
    assert_eq!(
        w.client.try_resolve_challenge(&id, &ResolutionMethod::WindowElapsed),
        Err(Ok(Error::InvalidResolutionMethod))
    );
    let chal = w.client.get_challenge(&id).unwrap();
    assert_eq!(chal.resolution, Resolution::None);
    assert!(!w.client.get_submission(&id).unwrap().finalized);

    // The real path still works afterwards.
    assert_eq!(
        w.client.resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus),
        Verdict::Slashed
    );
}

// ---- challenge flow end to end ----

#[test]
fn challenge_upheld_slashes_agent_bond_and_pays_challenger() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }

    let verdict = w.client.resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus);
    assert_eq!(verdict, Verdict::Slashed);

    // The prevailing challenger gets their own 50 XLM bond back plus 20% of
    // the 50 XLM forfeited agent bond (10 XLM); the other 40 XLM goes to the
    // treasury. Nothing is left in the contract for this submission.
    assert_eq!(w.token.balance(&challenger), 1000 * XLM + 10 * XLM);
    assert_eq!(w.token.balance(&w.admin), 40 * XLM);
    assert_eq!(w.token.balance(&agent), 950 * XLM);
    assert_eq!(w.token.balance(&w.client.address), 3 * 600 * XLM); // only re-executor stake remains
}

#[test]
fn challenge_rejected_verifies_agent() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    }

    let verdict = w.client.resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus);
    assert_eq!(verdict, Verdict::Verified);
    // The agent gets their bond back plus the losing challenger's forfeited
    // 50 XLM bond; the challenger is out exactly that bond.
    assert_eq!(w.token.balance(&agent), 1000 * XLM + 50 * XLM);
    assert_eq!(w.token.balance(&challenger), 950 * XLM);
    assert_eq!(w.token.balance(&w.client.address), 3 * 600 * XLM);
}

#[test]
fn unresolvable_challenge_expires_and_returns_both_bonds() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));

    // One lone vote: below quorum, so no consensus can ever form.
    let rex = Address::generate(&e);
    register_rex(&w, &rex);
    w.client.attest_replay(&rex, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);

    // Still inside the post-challenge window: nothing may move yet.
    e.ledger().with_mut(|l| l.timestamp += 3599);
    assert_eq!(w.client.finalize(&id), Verdict::Pending);
    assert_eq!(w.token.balance(&agent), 950 * XLM);

    e.ledger().with_mut(|l| l.timestamp += 1);
    assert_eq!(w.client.finalize(&id), Verdict::ExpiredUnverified);
    assert_eq!(w.token.balance(&agent), 1000 * XLM);
    assert_eq!(w.token.balance(&challenger), 1000 * XLM);
    assert_eq!(w.token.balance(&w.client.address), 600 * XLM);

    // Terminal and idempotent like every other verdict; nobody is slashable.
    assert_eq!(w.client.finalize(&id), Verdict::ExpiredUnverified);
    assert_eq!(
        w.client.get_submission(&id).unwrap().resolution_method,
        ResolutionMethod::WindowElapsed
    );
    assert_eq!(w.client.try_slash(&rex, &id), Err(Ok(Error::NotSlashable)));
}

#[test]
fn challenge_with_consensus_cannot_be_expired_around() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));

    for _ in 0..3 {
        let r = Address::generate(&e);
        register_rex(&w, &r);
        w.client.attest_replay(&r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }

    // A mismatch consensus exists. Waiting out the window must not let the
    // agent escape the slash via the expiry path — only resolve_challenge()
    // may settle it.
    e.ledger().with_mut(|l| l.timestamp += 10 * 3600);
    assert_eq!(w.client.finalize(&id), Verdict::Pending);
    assert_eq!(
        w.client.resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus),
        Verdict::Slashed
    );
}

// ---- withdraw / release_attestation_lock bookkeeping ----

#[test]
fn withdraw_is_blocked_while_attestation_is_open_then_unlocks_after_finalize() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex1 = Address::generate(&e);
    register_rex(&w, &rex1); // stake = 600 XLM, floor = 500 XLM
    w.client.attest_replay(&rex1, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);

    // The vote carried the full 600 XLM of weight, so none of it may leave
    // while the attestation is open — not even the 100 XLM above the floor,
    // or a voter could cast a heavy vote and keep only the floor at risk.
    for amount in [150 * XLM, 100 * XLM, 1] {
        let res = w.client.try_withdraw_stake(&rex1, &amount);
        assert!(matches!(res, Err(Ok(Error::StakeLockedByOpenAttestation))));
    }
    assert_eq!(w.client.reexecutor_info(&rex1).unwrap().stake_amount, 600 * XLM);

    e.ledger().set_timestamp(e.ledger().timestamp() + 3601);
    w.client.finalize(&id);

    w.client.release_attestation_lock(&id, &rex1);
    // Now fully unlocked — can withdraw everything.
    w.client.withdraw_stake(&rex1, &(600 * XLM));
    let info = w.client.reexecutor_info(&rex1).unwrap();
    assert_eq!(info.stake_amount, 0);
}

// ---- register_reexecutor top-ups and withdraw_stake edge cases ----

// ReexecutorInfo has no PartialEq, so a record is compared field by field.
fn assert_info_eq(actual: &ReexecutorInfo, expected: &ReexecutorInfo) {
    assert_eq!(actual.stake_amount, expected.stake_amount);
    assert_eq!(actual.active, expected.active);
    assert_eq!(actual.joined_at, expected.joined_at);
    assert_eq!(actual.open_attestations, expected.open_attestations);
    assert_eq!(actual.approved, expected.approved);
}

#[test]
fn register_reexecutor_rejects_a_non_positive_stake() {
    let e = Env::default();
    let w = setup(&e);
    let rex = Address::generate(&e);
    fund(&w, &rex, 1000 * XLM);

    for amount in [0, -1, -(600 * XLM)] {
        assert_eq!(
            w.client.try_register_reexecutor(&rex, &amount),
            Err(Ok(Error::InvalidAmount)),
            "{amount}"
        );
    }
    // Nothing moved and nothing was recorded.
    assert_eq!(w.token.balance(&rex), 1000 * XLM);
    assert_eq!(w.token.balance(&w.client.address), 0);
    assert!(w.client.reexecutor_info(&rex).is_none());

    // A registered re-executor is refused the same way and keeps its record.
    w.client.register_reexecutor(&rex, &(600 * XLM));
    let before = w.client.reexecutor_info(&rex).unwrap();
    for amount in [0, -1] {
        assert_eq!(
            w.client.try_register_reexecutor(&rex, &amount),
            Err(Ok(Error::InvalidAmount)),
            "{amount}"
        );
    }
    assert_info_eq(&w.client.reexecutor_info(&rex).unwrap(), &before);
    assert_eq!(w.token.balance(&rex), 400 * XLM);
    assert_eq!(w.token.balance(&w.client.address), 600 * XLM);
}

#[test]
fn a_top_up_keeps_joined_at_open_attestations_and_approval() {
    let e = Env::default();
    let w = setup(&e);
    // A start other than zero, so a top-up that reset joined_at would show.
    e.ledger().set_timestamp(500);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex = Address::generate(&e);
    register_rex(&w, &rex); // funded with 2000 XLM, stakes 600 XLM
    w.client.set_reexecutor_approved(&w.admin, &rex, &true);
    w.client
        .attest_replay(&rex, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    let before = w.client.reexecutor_info(&rex).unwrap();
    assert_eq!(before.joined_at, 500);
    assert_eq!(before.open_attestations, 1);
    assert!(before.approved);

    e.ledger().set_timestamp(1500);
    w.client.register_reexecutor(&rex, &(250 * XLM));

    let after = w.client.reexecutor_info(&rex).unwrap();
    assert_eq!(after.stake_amount, 850 * XLM);
    assert_eq!(after.joined_at, 500, "a top-up is not a new registration");
    assert_eq!(after.open_attestations, 1);
    assert!(after.approved);
    assert!(after.active);
    // Only the top-up moved.
    assert_eq!(w.token.balance(&rex), (2000 - 600 - 250) * XLM);
}

#[test]
fn a_top_up_to_the_floor_reactivates_an_inactive_reexecutor() {
    let e = Env::default();
    let w = setup(&e); // floor = 500 XLM
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let vote = BytesN::from_array(&e, &[3u8; 32]);

    let rex = Address::generate(&e);
    register_rex(&w, &rex);
    w.client.withdraw_stake(&rex, &(200 * XLM));
    assert!(!w.client.reexecutor_info(&rex).unwrap().active);
    assert_eq!(
        w.client.try_attest_replay(&rex, &id, &vote, &true),
        Err(Ok(Error::ReexecutorNotActive))
    );

    // One stroop short of the floor is still inactive.
    w.client.register_reexecutor(&rex, &(100 * XLM - 1));
    let short = w.client.reexecutor_info(&rex).unwrap();
    assert_eq!(short.stake_amount, 500 * XLM - 1);
    assert!(!short.active);

    // The stroop that reaches the floor brings it back, and it can vote again.
    w.client.register_reexecutor(&rex, &1);
    let back = w.client.reexecutor_info(&rex).unwrap();
    assert_eq!(back.stake_amount, 500 * XLM);
    assert!(back.active);
    w.client.attest_replay(&rex, &id, &vote, &true);
    assert_eq!(w.client.get_submission(&id).unwrap().match_votes, 1);
}

#[test]
fn withdraw_stake_rejects_a_non_positive_amount() {
    let e = Env::default();
    let w = setup(&e);
    let rex = Address::generate(&e);
    register_rex(&w, &rex);
    let before = w.client.reexecutor_info(&rex).unwrap();

    for amount in [0, -1, -(600 * XLM)] {
        assert_eq!(
            w.client.try_withdraw_stake(&rex, &amount),
            Err(Ok(Error::InvalidAmount)),
            "{amount}"
        );
    }
    assert_info_eq(&w.client.reexecutor_info(&rex).unwrap(), &before);
    assert_eq!(w.token.balance(&rex), 1400 * XLM);
    assert_eq!(w.token.balance(&w.client.address), 600 * XLM);
}

#[test]
fn withdraw_stake_is_refused_for_an_address_that_never_registered() {
    let e = Env::default();
    let w = setup(&e);
    // Somebody else's stake is in the contract, and must stay there.
    let rex = Address::generate(&e);
    register_rex(&w, &rex);
    let stranger = Address::generate(&e);
    fund(&w, &stranger, 100 * XLM);

    for amount in [1, 100 * XLM, 600 * XLM] {
        assert_eq!(
            w.client.try_withdraw_stake(&stranger, &amount),
            Err(Ok(Error::ReexecutorNotActive)),
            "{amount}"
        );
    }
    assert!(w.client.reexecutor_info(&stranger).is_none());
    assert_eq!(w.token.balance(&stranger), 100 * XLM);
    assert_eq!(w.token.balance(&w.client.address), 600 * XLM);
}

#[test]
fn a_withdrawal_that_leaves_less_than_the_floor_deactivates_and_blocks_the_next_vote() {
    let e = Env::default();
    let w = setup(&e); // floor = 500 XLM
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let vote = BytesN::from_array(&e, &[3u8; 32]);

    let rex = Address::generate(&e);
    register_rex(&w, &rex); // stake = 600 XLM

    // Down to exactly the floor: still active.
    w.client.withdraw_stake(&rex, &(100 * XLM));
    let at_floor = w.client.reexecutor_info(&rex).unwrap();
    assert_eq!(at_floor.stake_amount, 500 * XLM);
    assert!(at_floor.active);

    // One stroop below it: inactive, with the rest of the stake still held.
    w.client.withdraw_stake(&rex, &1);
    let below = w.client.reexecutor_info(&rex).unwrap();
    assert_eq!(below.stake_amount, 500 * XLM - 1);
    assert!(!below.active);
    assert_eq!(w.token.balance(&rex), 1500 * XLM + 1);
    assert_eq!(w.token.balance(&w.client.address), 50 * XLM + 500 * XLM - 1);

    // Its next vote is refused, and leaves no trace on the submission or on it.
    assert_eq!(
        w.client.try_attest_replay(&rex, &id, &vote, &true),
        Err(Ok(Error::ReexecutorNotActive))
    );
    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!(sub.match_votes, 0);
    assert_eq!(sub.bonded_weight_matched, 0);
    assert_eq!(w.client.reexecutor_info(&rex).unwrap().open_attestations, 0);
}

#[test]
fn stake_events_carry_the_new_stake_and_the_active_flag() {
    let e = Env::default();
    let w = setup(&e); // floor = 500 XLM
    let rex = Address::generate(&e);
    fund(&w, &rex, 2000 * XLM);
    let registered = |stake_amount: i128, active: bool| {
        ReexecutorRegistered {
            reexecutor: rex.clone(),
            stake_amount,
            active,
        }
        .to_xdr(&e, &w.client.address)
    };
    let withdrawn = |new_stake: i128, active: bool| {
        ReexecutorStakeWithdrawn {
            reexecutor: rex.clone(),
            new_stake,
            active,
        }
        .to_xdr(&e, &w.client.address)
    };

    // Registered below the floor: the stake is recorded, inactive.
    w.client.register_reexecutor(&rex, &(400 * XLM));
    let events = e.events().all();
    assert!(events.events().contains(&registered(400 * XLM, false)));

    // The event of a top-up carries the new total, not the amount added.
    w.client.register_reexecutor(&rex, &(200 * XLM));
    let events = e.events().all();
    assert!(events.events().contains(&registered(600 * XLM, true)));
    assert!(!events.events().contains(&registered(200 * XLM, true)));

    // A withdrawal below the floor reports what is left and that it is inactive.
    w.client.withdraw_stake(&rex, &(150 * XLM));
    let events = e.events().all();
    assert!(events.events().contains(&withdrawn(450 * XLM, false)));

    // Withdrawing the rest reports a stake of zero.
    w.client.withdraw_stake(&rex, &(450 * XLM));
    let events = e.events().all();
    assert!(events.events().contains(&withdrawn(0, false)));

    // A refused withdrawal publishes no event for the stake it did not reach.
    assert_eq!(
        w.client.try_withdraw_stake(&rex, &1),
        Err(Ok(Error::InvalidAmount))
    );
    let events = e.events().all();
    assert!(!events.events().contains(&withdrawn(-1, false)));
}

// ---- voter allow-list ----

#[test]
fn allowlist_gates_who_may_attest() {
    let e = Env::default();
    let w = setup_with(&e, ConfigRecord { reexecutor_allowlist: true, ..default_config() });
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let vote = BytesN::from_array(&e, &[3u8; 32]);

    let rex = Address::generate(&e);
    // Approval is a property of a registered re-executor.
    assert_eq!(
        w.client.try_set_reexecutor_approved(&w.admin, &rex, &true),
        Err(Ok(Error::ReexecutorNotActive))
    );
    register_rex(&w, &rex);
    assert!(!w.client.reexecutor_info(&rex).unwrap().approved);

    // Staked and active, but not approved: no vote.
    assert_eq!(
        w.client.try_attest_replay(&rex, &id, &vote, &true),
        Err(Ok(Error::ReexecutorNotApproved))
    );

    // Only the admin can approve.
    let stranger = Address::generate(&e);
    assert_eq!(
        w.client.try_set_reexecutor_approved(&stranger, &rex, &true),
        Err(Ok(Error::NotAdmin))
    );
    w.client.set_reexecutor_approved(&w.admin, &rex, &true);
    w.client.attest_replay(&rex, &id, &vote, &true);

    // Approval survives a stake top-up, and revoking it stops further votes.
    w.client.register_reexecutor(&rex, &(100 * XLM));
    assert!(w.client.reexecutor_info(&rex).unwrap().approved);
    w.client.set_reexecutor_approved(&w.admin, &rex, &false);
    let id2 = submit_default(&w, &agent);
    assert_eq!(
        w.client.try_attest_replay(&rex, &id2, &vote, &true),
        Err(Ok(Error::ReexecutorNotApproved))
    );
}

#[test]
fn allowlist_off_lets_any_active_staker_attest() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex = Address::generate(&e);
    register_rex(&w, &rex);
    assert!(!w.client.reexecutor_info(&rex).unwrap().approved);
    w.client.attest_replay(&rex, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
}

// ---- deployment and input guards ----

#[test]
fn submit_rejects_a_zero_bond_even_when_the_proportional_minimum_rounds_to_zero() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    fund(&w, &agent, 1000 * XLM);

    // 5% of 10 stroops rounds down to 0, so the proportional check alone
    // would wave a bond of nothing through.
    let res = w.client.try_submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &10,
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &0,
    );
    assert_eq!(res, Err(Ok(Error::BondTooLow)));
}

#[test]
#[should_panic]
fn constructor_rejects_an_invalid_config() {
    let e = Env::default();
    setup_with(&e, ConfigRecord { reexecutor_slash_bps: 10_001, ..default_config() });
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_small_window_above_max() {
    let e = Env::default();
    setup_with(
        &e,
        ConfigRecord {
            window_tier_small_s: crate::MAX_WINDOW_S + 1,
            ..default_config()
        },
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_large_window_above_max() {
    let e = Env::default();
    setup_with(
        &e,
        ConfigRecord {
            window_tier_large_s: crate::MAX_WINDOW_S + 1,
            ..default_config()
        },
    );
}

#[test]
fn constructor_accepts_windows_at_max() {
    let e = Env::default();
    let w = setup_with(
        &e,
        ConfigRecord {
            window_tier_small_s: crate::MAX_WINDOW_S,
            window_tier_large_s: crate::MAX_WINDOW_S,
            ..default_config()
        },
    );
    let cfg = w.client.get_config().unwrap();
    assert_eq!(cfg.window_tier_small_s, crate::MAX_WINDOW_S);
    assert_eq!(cfg.window_tier_large_s, crate::MAX_WINDOW_S);
}

#[test]
fn update_config_rejects_each_window_tier_above_max() {
    let e = Env::default();
    let w = setup_with(&e, default_config());

    let cfg_small = ConfigRecord {
        window_tier_small_s: crate::MAX_WINDOW_S + 1,
        ..default_config()
    };
    assert_eq!(
        w.client.try_update_config(&w.admin, &cfg_small),
        Err(Ok(Error::InvalidConfig))
    );
    assert_eq!(w.client.get_config().unwrap().window_tier_small_s, 3600);

    let cfg_large = ConfigRecord {
        window_tier_large_s: crate::MAX_WINDOW_S + 1,
        ..default_config()
    };
    assert_eq!(
        w.client.try_update_config(&w.admin, &cfg_large),
        Err(Ok(Error::InvalidConfig))
    );
    assert_eq!(w.client.get_config().unwrap().window_tier_large_s, 86_400);
}

#[test]
fn update_config_accepts_windows_at_max() {
    let e = Env::default();
    let w = setup_with(&e, default_config());

    let cfg = ConfigRecord {
        window_tier_small_s: crate::MAX_WINDOW_S,
        window_tier_large_s: crate::MAX_WINDOW_S,
        ..default_config()
    };
    w.client.update_config(&w.admin, &cfg);
    let updated = w.client.get_config().unwrap();
    assert_eq!(updated.window_tier_small_s, crate::MAX_WINDOW_S);
    assert_eq!(updated.window_tier_large_s, crate::MAX_WINDOW_S);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_a_zero_min_stake_floor() {
    let e = Env::default();
    setup_with(&e, ConfigRecord { min_stake_floor: 0, ..default_config() });
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_a_negative_min_stake_floor() {
    let e = Env::default();
    setup_with(&e, ConfigRecord { min_stake_floor: -1, ..default_config() });
}

#[test]
fn update_config_rejects_a_non_positive_min_stake_floor() {
    let e = Env::default();
    let w = setup_with(&e, default_config());

    for floor in [0, -1] {
        let cfg = ConfigRecord { min_stake_floor: floor, ..default_config() };
        assert_eq!(w.client.try_update_config(&w.admin, &cfg), Err(Ok(Error::InvalidConfig)));
        // The rejected update leaves the stored config alone.
        assert_eq!(w.client.get_config().unwrap().min_stake_floor, 500 * XLM);
    }
}

#[test]
fn update_config_accepts_a_min_stake_floor_of_one() {
    let e = Env::default();
    let w = setup_with(&e, default_config());

    w.client.update_config(&w.admin, &ConfigRecord { min_stake_floor: 1, ..default_config() });

    assert_eq!(w.client.get_config().unwrap().min_stake_floor, 1);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_window_tier_small_above_max() {
    let e = Env::default();
    setup_with(
        &e,
        ConfigRecord {
            window_tier_small_s: crate::MAX_WINDOW_S + 1,
            ..default_config()
        },
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_window_tier_large_above_max() {
    let e = Env::default();
    setup_with(
        &e,
        ConfigRecord {
            window_tier_large_s: crate::MAX_WINDOW_S + 1,
            ..default_config()
        },
    );
}

#[test]
fn update_config_rejects_windows_above_max() {
    let e = Env::default();
    let w = setup_with(&e, default_config());

    let cfg_small = ConfigRecord {
        window_tier_small_s: crate::MAX_WINDOW_S + 1,
        ..default_config()
    };
    assert_eq!(w.client.try_update_config(&w.admin, &cfg_small), Err(Ok(Error::InvalidConfig)));
    assert_eq!(w.client.get_config().unwrap().window_tier_small_s, 3600);

    let cfg_large = ConfigRecord {
        window_tier_large_s: crate::MAX_WINDOW_S + 1,
        ..default_config()
    };
    assert_eq!(w.client.try_update_config(&w.admin, &cfg_large), Err(Ok(Error::InvalidConfig)));
    assert_eq!(w.client.get_config().unwrap().window_tier_large_s, 86_400);
}

#[test]
fn config_accepts_max_window_boundary() {
    let e = Env::default();
    assert_eq!(crate::MAX_WINDOW_S, 604_800);
    let cfg = ConfigRecord {
        window_tier_small_s: crate::MAX_WINDOW_S,
        window_tier_large_s: crate::MAX_WINDOW_S,
        ..default_config()
    };
    let w = setup_with(&e, cfg.clone());
    assert_eq!(w.client.get_config().unwrap().window_tier_small_s, crate::MAX_WINDOW_S);
    assert_eq!(w.client.get_config().unwrap().window_tier_large_s, crate::MAX_WINDOW_S);

    w.client.update_config(&w.admin, &cfg);
    assert_eq!(w.client.get_config().unwrap().window_tier_small_s, crate::MAX_WINDOW_S);
    assert_eq!(w.client.get_config().unwrap().window_tier_large_s, crate::MAX_WINDOW_S);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_a_small_window_longer_than_the_large_one() {
    let e = Env::default();
    // The example from the issue: a small job would get 7 days and a large one 10 minutes.
    setup_with(
        &e,
        ConfigRecord {
            window_tier_small_s: crate::MAX_WINDOW_S,
            window_tier_large_s: ConfigRecord::MIN_WINDOW_S,
            ..default_config()
        },
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn constructor_rejects_a_small_window_one_second_longer_than_the_large_one() {
    let e = Env::default();
    setup_with(
        &e,
        ConfigRecord {
            window_tier_small_s: 3601,
            window_tier_large_s: 3600,
            ..default_config()
        },
    );
}

#[test]
fn equal_window_tiers_are_accepted_by_the_constructor_and_by_update_config() {
    // One window for every escrow. 600 / 600 is what the dev deployment uses.
    for window in [ConfigRecord::MIN_WINDOW_S, 3600, crate::MAX_WINDOW_S] {
        let e = Env::default();
        let cfg = ConfigRecord {
            window_tier_small_s: window,
            window_tier_large_s: window,
            ..default_config()
        };
        let w = setup_with(&e, cfg.clone());
        assert_config_eq(&w.client.get_config().unwrap(), &cfg);

        let other = setup(&e);
        other.client.update_config(&other.admin, &cfg);
        assert_config_eq(&other.client.get_config().unwrap(), &cfg);
    }
}

#[test]
fn a_small_window_shorter_than_the_large_one_is_still_accepted() {
    let e = Env::default();
    // The testnet defaults, and the closest the two can get without being equal.
    for (small, large) in [
        (3600, 86_400),
        (3599, 3600),
        (ConfigRecord::MIN_WINDOW_S, crate::MAX_WINDOW_S),
    ] {
        let cfg = ConfigRecord {
            window_tier_small_s: small,
            window_tier_large_s: large,
            ..default_config()
        };
        let w = setup_with(&e, cfg.clone());
        assert_config_eq(&w.client.get_config().unwrap(), &cfg);
        w.client.update_config(&w.admin, &default_config());
        w.client.update_config(&w.admin, &cfg);
        assert_config_eq(&w.client.get_config().unwrap(), &cfg);
    }
}

#[test]
fn zero_slash_bps_disables_reexecutor_slashing() {
    let e = Env::default();
    let w = setup_with(&e, ConfigRecord { reexecutor_slash_bps: 0, ..default_config() });
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let wrong = Address::generate(&e);
    register_rex(&w, &wrong);
    w.client.attest_replay(&wrong, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    for _ in 0..2 {
        let r = Address::generate(&e);
        register_rex(&w, &r);
        w.client.attest_replay(&r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }
    assert_eq!(w.client.finalize(&id), Verdict::Slashed);

    assert_eq!(w.client.try_slash(&wrong, &id), Err(Ok(Error::NotSlashable)));
    w.client.release_attestation_lock(&id, &wrong);
    assert_eq!(w.client.reexecutor_info(&wrong).unwrap().stake_amount, 600 * XLM);
}

#[test]
fn release_attestation_lock_extends_instance_ttl() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let rex = Address::generate(&e);
    register_rex(&w, &rex);
    w.client.attest_replay(&rex, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);

    e.ledger().set_timestamp(e.ledger().timestamp() + 3601);
    assert_eq!(w.client.finalize(&id), Verdict::Verified);

    // Finalize bumped the instance TTL to BUMP_TO (500_000 ledgers; see storage.rs).
    let ttl = e.as_contract(&w.client.address, || e.storage().instance().get_ttl());
    assert_eq!(ttl, 500_000);

    // Let the TTL decay below BUMP_THRESHOLD (100_000 ledgers) by advancing sequence.
    e.ledger().with_mut(|l| l.sequence_number += 450_000);
    let decayed_ttl = e.as_contract(&w.client.address, || e.storage().instance().get_ttl());
    assert_eq!(decayed_ttl, 50_000);

    // release_attestation_lock must bump the instance TTL back to 500_000.
    w.client.release_attestation_lock(&id, &rex);
    let restored_ttl = e.as_contract(&w.client.address, || e.storage().instance().get_ttl());
    assert_eq!(restored_ttl, 500_000);
}

#[test]
fn slash_extends_instance_ttl() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let wrong = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&wrong, &rex2, &rex3] {
        register_rex(&w, r);
    }
    w.client.attest_replay(&wrong, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    w.client.attest_replay(&rex2, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    w.client.attest_replay(&rex3, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);

    assert_eq!(w.client.finalize(&id), Verdict::Slashed);

    // Finalize bumped the instance TTL to 500_000 ledgers.
    let ttl = e.as_contract(&w.client.address, || e.storage().instance().get_ttl());
    assert_eq!(ttl, 500_000);

    // Let the TTL decay below BUMP_THRESHOLD (100_000 ledgers) by advancing sequence.
    e.ledger().with_mut(|l| l.sequence_number += 450_000);
    let decayed_ttl = e.as_contract(&w.client.address, || e.storage().instance().get_ttl());
    assert_eq!(decayed_ttl, 50_000);

    // slash must bump the instance TTL back to 500_000.
    assert_eq!(w.client.slash(&wrong, &id), 60 * XLM);
    let restored_ttl = e.as_contract(&w.client.address, || e.storage().instance().get_ttl());
    assert_eq!(restored_ttl, 500_000);
}

// ---- error paths ----

fn assert_config_eq(actual: &ConfigRecord, expected: &ConfigRecord) {
    assert_eq!(format!("{actual:?}"), format!("{expected:?}"));
}

#[test]
fn submit_rejects_a_non_positive_escrow_value() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    fund(&w, &agent, 1000 * XLM);

    for escrow_value in [0, -1] {
        let res = w.client.try_submit(
            &agent,
            &BytesN::from_array(&e, &[1u8; 32]),
            &escrow_value,
            &TaskType::Deterministic,
            &BytesN::from_array(&e, &[2u8; 32]),
            &BytesN::from_array(&e, &[3u8; 32]),
            &(50 * XLM),
        );
        assert_eq!(res, Err(Ok(Error::InvalidEscrowValue)));
    }
    assert_eq!(w.token.balance(&agent), 1000 * XLM);
    assert!(w.client.get_submission(&0).is_none());
}

#[test]
fn every_entrypoint_rejects_an_unknown_submission_id() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    submit_default(&w, &agent);
    let missing = 99u64;

    let rex = Address::generate(&e);
    register_rex(&w, &rex);
    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);

    assert_eq!(w.client.try_finalize(&missing), Err(Ok(Error::SubmissionNotFound)));
    assert_eq!(
        w.client.try_attest_replay(&rex, &missing, &BytesN::from_array(&e, &[3u8; 32]), &true),
        Err(Ok(Error::SubmissionNotFound))
    );
    assert_eq!(
        w.client.try_open_challenge(&challenger, &missing, &(50 * XLM)),
        Err(Ok(Error::SubmissionNotFound))
    );
    assert_eq!(
        w.client.try_resolve_challenge(&missing, &ResolutionMethod::ReexecutionConsensus),
        Err(Ok(Error::SubmissionNotFound))
    );
    assert_eq!(
        w.client.try_release_attestation_lock(&missing, &rex),
        Err(Ok(Error::SubmissionNotFound))
    );
    assert_eq!(w.client.try_slash(&rex, &missing), Err(Ok(Error::SubmissionNotFound)));

    assert_eq!(w.client.reexecutor_info(&rex).unwrap().open_attestations, 0);
    assert_eq!(w.token.balance(&challenger), 1000 * XLM);
}

#[test]
fn a_reexecutor_cannot_vote_twice_on_one_submission() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let rex = Address::generate(&e);
    register_rex(&w, &rex);
    let vote = BytesN::from_array(&e, &[3u8; 32]);
    w.client.attest_replay(&rex, &id, &vote, &true);

    for matched in [true, false] {
        assert_eq!(
            w.client.try_attest_replay(&rex, &id, &vote, &matched),
            Err(Ok(Error::AlreadyAttested))
        );
    }
    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!((sub.match_votes, sub.mismatch_votes), (1, 0));
    assert_eq!(sub.bonded_weight_matched, 600 * XLM);
    assert_eq!(w.client.reexecutor_info(&rex).unwrap().open_attestations, 1);
}

#[test]
fn an_attestation_lock_cannot_be_released_twice() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let other = submit_default(&w, &agent);
    let rex = Address::generate(&e);
    register_rex(&w, &rex);
    let vote = BytesN::from_array(&e, &[3u8; 32]);
    w.client.attest_replay(&rex, &id, &vote, &true);
    w.client.attest_replay(&rex, &other, &vote, &true);

    e.ledger().set_timestamp(e.ledger().timestamp() + 3601);
    assert_eq!(w.client.finalize(&id), Verdict::Verified);
    w.client.release_attestation_lock(&id, &rex);
    assert_eq!(
        w.client.try_release_attestation_lock(&id, &rex),
        Err(Ok(Error::AttestationAlreadyReleased))
    );

    assert_eq!(w.client.reexecutor_info(&rex).unwrap().open_attestations, 1);
    assert_eq!(
        w.client.try_withdraw_stake(&rex, &(150 * XLM)),
        Err(Ok(Error::StakeLockedByOpenAttestation))
    );
}

#[test]
fn a_second_challenge_on_one_submission_is_rejected() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let first = Address::generate(&e);
    fund(&w, &first, 1000 * XLM);
    w.client.open_challenge(&first, &id, &(50 * XLM));

    let second = Address::generate(&e);
    fund(&w, &second, 1000 * XLM);
    let held = w.token.balance(&w.client.address);
    assert_eq!(
        w.client.try_open_challenge(&second, &id, &(50 * XLM)),
        Err(Ok(Error::ChallengeAlreadyOpen))
    );
    assert_eq!(w.token.balance(&second), 1000 * XLM);
    assert_eq!(w.token.balance(&w.client.address), held);
    assert_eq!(w.client.get_challenge(&id).unwrap().challenger, first);
}

#[test]
fn resolving_an_unchallenged_submission_is_rejected() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    for _ in 0..3 {
        let r = Address::generate(&e);
        register_rex(&w, &r);
        w.client.attest_replay(&r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }
    assert_eq!(
        w.client.try_resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus),
        Err(Ok(Error::ChallengeNotFound))
    );
    assert!(!w.client.get_submission(&id).unwrap().finalized);
}

#[test]
fn resolving_a_challenge_without_a_bonded_consensus_is_rejected() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));

    let rex = Address::generate(&e);
    register_rex(&w, &rex);
    w.client.attest_replay(&rex, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    assert_eq!(
        w.client.try_resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus),
        Err(Ok(Error::InsufficientConsensus))
    );

    for matched in [true, true, false] {
        let r = Address::generate(&e);
        register_rex(&w, &r);
        let hash = BytesN::from_array(&e, &[if matched { 3u8 } else { 9u8 }; 32]);
        w.client.attest_replay(&r, &id, &hash, &matched);
    }
    assert_eq!(
        w.client.try_resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus),
        Err(Ok(Error::InsufficientConsensus))
    );

    assert_eq!(w.client.get_challenge(&id).unwrap().resolution, Resolution::None);
    assert!(!w.client.get_submission(&id).unwrap().finalized);
    assert_eq!(w.token.balance(&agent), 950 * XLM);
    assert_eq!(w.token.balance(&challenger), 950 * XLM);
}

#[test]
fn a_resolved_challenge_cannot_be_resolved_again() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));
    for _ in 0..3 {
        let r = Address::generate(&e);
        register_rex(&w, &r);
        w.client.attest_replay(&r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }
    assert_eq!(
        w.client.resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus),
        Verdict::Slashed
    );

    let challenger_before = w.token.balance(&challenger);
    let admin_before = w.token.balance(&w.admin);
    assert_eq!(
        w.client.try_resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus),
        Err(Ok(Error::ChallengeAlreadyResolved))
    );
    assert_eq!(w.token.balance(&challenger), challenger_before);
    assert_eq!(w.token.balance(&w.admin), admin_before);
}

#[test]
fn submit_and_register_report_not_initialized_without_a_stored_config() {
    let e = Env::default();
    let w = setup(&e);
    e.as_contract(&w.client.address, || {
        e.storage().instance().remove(&crate::storage::DataKey::Config)
    });

    let agent = Address::generate(&e);
    fund(&w, &agent, 1000 * XLM);
    let res = w.client.try_submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );
    assert_eq!(res, Err(Ok(Error::NotInitialized)));

    let rex = Address::generate(&e);
    fund(&w, &rex, 2000 * XLM);
    assert_eq!(
        w.client.try_register_reexecutor(&rex, &(600 * XLM)),
        Err(Ok(Error::NotInitialized))
    );
}

#[test]
fn update_config_by_the_admin_replaces_every_field() {
    let e = Env::default();
    let w = setup(&e);
    let cfg = ConfigRecord {
        min_stake_floor: 800 * XLM,
        quorum_min_reexecutors: 5,
        quorum_supermajority_bps: 7500,
        agent_bond_min_bps: 1000,
        challenger_bond_min_bps: 250,
        window_tier_small_ceiling: 50_000 * XLM,
        window_tier_small_s: 7200,
        window_tier_large_s: 172_800,
        slash_split_challenger_bps: 5000,
        reexecutor_slash_bps: 2500,
        reexecutor_allowlist: true,
    };

    w.client.update_config(&w.admin, &cfg);
    assert_config_eq(&w.client.get_config().unwrap(), &cfg);
}

#[test]
fn update_config_rejects_anyone_but_the_admin() {
    let e = Env::default();
    let w = setup(&e);
    let stranger = Address::generate(&e);
    let cfg = ConfigRecord { quorum_min_reexecutors: 5, ..default_config() };

    assert_eq!(w.client.try_update_config(&stranger, &cfg), Err(Ok(Error::NotAdmin)));
    assert_config_eq(&w.client.get_config().unwrap(), &default_config());
}

#[test]
fn update_config_rejects_each_invalid_rule() {
    let e = Env::default();
    let w = setup(&e);
    let d = default_config;
    let below_min_window = ConfigRecord::MIN_WINDOW_S - 1;
    let above_max_bps = ConfigRecord::MAX_BPS + 1;
    let cases = [
        (
            "supermajority below 51%",
            ConfigRecord {
                quorum_supermajority_bps: ConfigRecord::MIN_SUPERMAJORITY_BPS - 1,
                ..d()
            },
        ),
        (
            "supermajority above 100%",
            ConfigRecord { quorum_supermajority_bps: above_max_bps, ..d() },
        ),
        ("small window too short", ConfigRecord { window_tier_small_s: below_min_window, ..d() }),
        ("large window too short", ConfigRecord { window_tier_large_s: below_min_window, ..d() }),
        (
            "small window longer than the large one",
            ConfigRecord { window_tier_small_s: 7200, window_tier_large_s: 3600, ..d() },
        ),
        (
            "small window one second longer than the large one",
            ConfigRecord { window_tier_small_s: 3601, window_tier_large_s: 3600, ..d() },
        ),
        ("zero agent bond", ConfigRecord { agent_bond_min_bps: 0, ..d() }),
        ("agent bond above 100%", ConfigRecord { agent_bond_min_bps: above_max_bps, ..d() }),
        ("zero challenger bond", ConfigRecord { challenger_bond_min_bps: 0, ..d() }),
        (
            "challenger bond above 100%",
            ConfigRecord { challenger_bond_min_bps: above_max_bps, ..d() },
        ),
        (
            "challenger split above 100%",
            ConfigRecord { slash_split_challenger_bps: above_max_bps, ..d() },
        ),
        (
            "re-executor slash above 100%",
            ConfigRecord { reexecutor_slash_bps: above_max_bps, ..d() },
        ),
        ("zero quorum", ConfigRecord { quorum_min_reexecutors: 0, ..d() }),
        ("negative small-tier ceiling", ConfigRecord { window_tier_small_ceiling: -1, ..d() }),
    ];

    for (rule, cfg) in cases {
        assert_eq!(
            w.client.try_update_config(&w.admin, &cfg),
            Err(Ok(Error::InvalidConfig)),
            "{rule}"
        );
        assert_config_eq(&w.client.get_config().unwrap(), &default_config());
    }
}

#[test]
fn update_config_reports_not_initialized_without_a_stored_admin() {
    let e = Env::default();
    let w = setup(&e);
    e.as_contract(&w.client.address, || {
        e.storage().instance().remove(&crate::storage::DataKey::Admin)
    });

    let cfg = ConfigRecord { quorum_min_reexecutors: 5, ..default_config() };
    assert_eq!(w.client.try_update_config(&w.admin, &cfg), Err(Ok(Error::NotInitialized)));
    assert_config_eq(&w.client.get_config().unwrap(), &default_config());
}

// ---- config snapshot ----

#[test]
fn snapshot_quorum_min_reexecutors_preserved_after_update_config() {
    // A submission created under default quorum (3) finalizes once 3 re-executors
    // vote matching, even after update_config increases live quorum to 5.
    // If live config were read, it would stay Pending.
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!(sub.cfg_quorum_min_reexecutors, 3);

    w.client.update_config(
        &w.admin,
        &ConfigRecord {
            quorum_min_reexecutors: 5,
            ..default_config()
        },
    );

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    }

    assert_eq!(w.client.finalize(&id), Verdict::Verified);
    let fin = w.client.get_submission(&id).unwrap();
    assert_eq!(fin.resolution_method, ResolutionMethod::ReexecutionConsensus);
}

#[test]
fn snapshot_quorum_supermajority_bps_preserved_after_update_config() {
    // 2 out of 3 votes with equal stake is 66.7%, which exceeds A's 66% (6600 bps),
    // but would fail under B's 90% (9000 bps).
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!(sub.cfg_quorum_supermajority_bps, 6600);

    w.client.update_config(
        &w.admin,
        &ConfigRecord {
            quorum_supermajority_bps: 9000,
            ..default_config()
        },
    );

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    register_rex(&w, &rex1);
    register_rex(&w, &rex2);
    register_rex(&w, &rex3);

    w.client.attest_replay(&rex1, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    w.client.attest_replay(&rex2, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    w.client.attest_replay(&rex3, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);

    assert_eq!(w.client.finalize(&id), Verdict::Verified);
}

#[test]
fn snapshot_challenger_bond_min_bps_preserved_after_update_config() {
    // Submission 1 created under A (500 bps = 50 XLM on 1000 XLM escrow) accepts 50 XLM bond.
    // After update to B (2000 bps = 200 XLM), submission 1 still accepts 50 XLM bond.
    // Submission 2 created after update requires 200 XLM (50 XLM rejected with BondTooLow).
    let e = Env::default();
    let w = setup(&e);
    let agent1 = Address::generate(&e);
    let id1 = submit_default(&w, &agent1);

    let sub1 = w.client.get_submission(&id1).unwrap();
    assert_eq!(sub1.cfg_challenger_bond_min_bps, 500);

    w.client.update_config(
        &w.admin,
        &ConfigRecord {
            challenger_bond_min_bps: 2000,
            ..default_config()
        },
    );

    // Existing submission under A accepts 50 XLM bond
    let challenger1 = Address::generate(&e);
    fund(&w, &challenger1, 1000 * XLM);
    w.client.open_challenge(&challenger1, &id1, &(50 * XLM));

    // New submission after update follows B (2000 bps)
    let agent2 = Address::generate(&e);
    fund(&w, &agent2, 1000 * XLM);
    let id2 = w.client.submit(
        &agent2,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );
    let sub2 = w.client.get_submission(&id2).unwrap();
    assert_eq!(sub2.cfg_challenger_bond_min_bps, 2000);

    let challenger2 = Address::generate(&e);
    fund(&w, &challenger2, 1000 * XLM);
    assert_eq!(
        w.client.try_open_challenge(&challenger2, &id2, &(50 * XLM)),
        Err(Ok(Error::BondTooLow))
    );
    w.client.open_challenge(&challenger2, &id2, &(200 * XLM));
}

#[test]
fn snapshot_slash_split_challenger_bps_preserved_after_update_config() {
    // Under A, challenger gets 20% (2000 bps) of agent bond (10 XLM of 50 XLM), admin gets 40 XLM.
    // Update changes live split to 50% (5000 bps). If live config were read, challenger would get 25 XLM.
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!(sub.cfg_slash_split_challenger_bps, 2000);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 1000 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        register_rex(&w, r);
        w.client.attest_replay(r, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }

    w.client.update_config(
        &w.admin,
        &ConfigRecord {
            slash_split_challenger_bps: 5000,
            ..default_config()
        },
    );

    let verdict = w.client.resolve_challenge(&id, &ResolutionMethod::ReexecutionConsensus);
    assert_eq!(verdict, Verdict::Slashed);

    assert_eq!(w.token.balance(&challenger), 1000 * XLM + 10 * XLM);
    assert_eq!(w.token.balance(&w.admin), 40 * XLM);
}

#[test]
fn snapshot_reexecutor_slash_bps_preserved_after_update_config() {
    // Under A, re-executor slash is 10% (1000 bps) = 60 XLM of 600 XLM stake.
    // Update changes live slash to 50% (5000 bps) = 300 XLM.
    // The snapshot ensures slash(&wrong, &id) slashes 60 XLM, not 300 XLM.
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!(sub.cfg_reexecutor_slash_bps, 1000);

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    register_rex(&w, &rex1);
    register_rex(&w, &rex2);
    register_rex(&w, &rex3);

    w.client.attest_replay(&rex1, &id, &BytesN::from_array(&e, &[3u8; 32]), &true);
    w.client.attest_replay(&rex2, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    w.client.attest_replay(&rex3, &id, &BytesN::from_array(&e, &[9u8; 32]), &false);

    assert_eq!(w.client.finalize(&id), Verdict::Slashed);

    w.client.update_config(
        &w.admin,
        &ConfigRecord {
            reexecutor_slash_bps: 5000,
            ..default_config()
        },
    );

    assert_eq!(w.client.slash(&rex1, &id), 60 * XLM);
    assert_eq!(w.client.reexecutor_info(&rex1).unwrap().stake_amount, 540 * XLM);
}

#[test]
fn snapshot_challenge_window_s_preserved_after_update_config() {
    // Under A, small window is 3600s. Update changes window_tier_small_s to 7200s.
    // Advancing ledger timestamp by 3601s finalizes the submission under A's window.
    // If live config were read (7200s), it would fail with ChallengeWindowOpen.
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);

    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!(sub.challenge_window_s, 3600);

    w.client.update_config(
        &w.admin,
        &ConfigRecord {
            window_tier_small_s: 7200,
            ..default_config()
        },
    );

    e.ledger().set_timestamp(3601);

    assert_eq!(w.client.finalize(&id), Verdict::Verified);
    let fin = w.client.get_submission(&id).unwrap();
    assert_eq!(fin.resolution_method, ResolutionMethod::WindowElapsed);
    assert_eq!(fin.challenge_window_s, 3600);
}

// ---- challenge-window boundaries, tier cutoff and Retrieval tasks ----

fn submit_with(w: &World, agent: &Address, escrow_value: i128, bond: i128, task_type: TaskType) -> u64 {
    fund(w, agent, bond);
    w.client.submit(
        agent,
        &BytesN::from_array(&w.e, &[1u8; 32]),
        &escrow_value,
        &task_type,
        &BytesN::from_array(&w.e, &[2u8; 32]),
        &BytesN::from_array(&w.e, &[3u8; 32]),
        &bond,
    )
}

/// Submits the default 1,000 XLM Deterministic work, moves the clock
/// `offset` seconds past the submit time, and tries to open a challenge.
fn open_challenge_after(offset: u64) -> Result<(), Error> {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let start = e.ledger().timestamp();
    let id = submit_default(&w, &agent);

    let challenger = Address::generate(&e);
    fund(&w, &challenger, 50 * XLM);
    e.ledger().set_timestamp(start + offset);
    match w.client.try_open_challenge(&challenger, &id, &(50 * XLM)) {
        Ok(Ok(_)) => Ok(()),
        Err(Ok(err)) => Err(err),
        other => panic!("unexpected result: {other:?}"),
    }
}

/// Submits work with the given escrow value (bond at exactly 5 percent), moves
/// the clock `offset` seconds past the submit time and finalizes with no votes
/// and no challenge. Returns the verdict and the stored submission.
fn finalize_after(
    escrow_value: i128,
    bond: i128,
    task_type: TaskType,
    offset: u64,
) -> (Verdict, verity_common::SubmissionRecord) {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let start = e.ledger().timestamp();
    let id = submit_with(&w, &agent, escrow_value, bond, task_type);
    e.ledger().set_timestamp(start + offset);
    let verdict = w.client.finalize(&id);
    (verdict, w.client.get_submission(&id).unwrap())
}

#[test]
fn open_challenge_is_accepted_one_second_before_the_window_closes() {
    assert_eq!(open_challenge_after(3599), Ok(()));
}

#[test]
fn open_challenge_closes_exactly_at_the_window_deadline() {
    assert_eq!(open_challenge_after(3600), Err(Error::ChallengeWindowClosed));
}

#[test]
fn open_challenge_stays_closed_one_second_after_the_deadline() {
    assert_eq!(open_challenge_after(3601), Err(Error::ChallengeWindowClosed));
}

#[test]
fn finalize_stays_pending_one_second_before_the_window_closes() {
    let (verdict, sub) = finalize_after(1000 * XLM, 50 * XLM, TaskType::Deterministic, 3599);
    assert_eq!(verdict, Verdict::Pending);
    assert!(!sub.finalized);
}

#[test]
fn finalize_verifies_by_default_exactly_at_the_window_deadline() {
    let (verdict, sub) = finalize_after(1000 * XLM, 50 * XLM, TaskType::Deterministic, 3600);
    assert_eq!(verdict, Verdict::Verified);
    assert!(sub.finalized);
    assert_eq!(sub.resolution_method, ResolutionMethod::WindowElapsed);
}

#[test]
fn finalize_verifies_by_default_one_second_after_the_deadline() {
    let (verdict, sub) = finalize_after(1000 * XLM, 50 * XLM, TaskType::Deterministic, 3601);
    assert_eq!(verdict, Verdict::Verified);
    assert_eq!(sub.resolution_method, ResolutionMethod::WindowElapsed);
}

#[test]
fn escrow_value_just_below_the_ceiling_gets_the_small_window() {
    let ceiling = default_config().window_tier_small_ceiling;
    let (_, sub) = finalize_after(ceiling - 1, 5_000 * XLM, TaskType::Deterministic, 0);
    assert_eq!(sub.challenge_window_s, 3600);
}

#[test]
fn escrow_value_at_the_ceiling_gets_the_large_window() {
    let ceiling = default_config().window_tier_small_ceiling;
    let (_, sub) = finalize_after(ceiling, 5_000 * XLM, TaskType::Deterministic, 0);
    assert_eq!(sub.challenge_window_s, 86_400);
}

#[test]
fn large_tier_window_closes_exactly_at_86400_seconds() {
    let ceiling = default_config().window_tier_small_ceiling;

    let (verdict, sub) = finalize_after(ceiling, 5_000 * XLM, TaskType::Deterministic, 86_399);
    assert_eq!(verdict, Verdict::Pending);
    assert!(!sub.finalized);

    let (verdict, sub) = finalize_after(ceiling, 5_000 * XLM, TaskType::Deterministic, 86_400);
    assert_eq!(verdict, Verdict::Verified);
    assert_eq!(sub.resolution_method, ResolutionMethod::WindowElapsed);
}

#[test]
fn retrieval_task_with_no_votes_is_verified_by_default_once_the_window_elapses() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let start = e.ledger().timestamp();
    let id = submit_with(&w, &agent, 1000 * XLM, 50 * XLM, TaskType::Retrieval);
    assert_eq!(w.token.balance(&agent), 0);

    e.ledger().set_timestamp(start + 3599);
    assert_eq!(w.client.finalize(&id), Verdict::Pending);
    assert_eq!(w.token.balance(&agent), 0);

    e.ledger().set_timestamp(start + 3600);
    assert_eq!(w.client.finalize(&id), Verdict::Verified);
    assert_eq!(w.token.balance(&agent), 50 * XLM);
    assert_eq!(
        w.client.get_submission(&id).unwrap().resolution_method,
        ResolutionMethod::WindowElapsed
    );
}

mod proptest_model;

// ---- vote and submission input validation ----

#[test]
fn an_all_zero_claimed_output_hash_is_rejected() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    fund(&w, &agent, 1000 * XLM);
    let res = w.client.try_submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[0u8; 32]),
        &(50 * XLM),
    );
    assert_eq!(res, Err(Ok(Error::InvalidOutputHash)));
}

#[test]
fn the_submitting_agent_cannot_attest_its_own_submission() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    register_rex(&w, &agent);

    let claimed = BytesN::from_array(&e, &[3u8; 32]);
    assert_eq!(
        w.client.try_attest_replay(&agent, &id, &claimed, &true),
        Err(Ok(Error::AgentCannotAttest))
    );
    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!(sub.match_votes, 0);
    assert_eq!(w.client.reexecutor_info(&agent).unwrap().open_attestations, 0);
}

#[test]
fn the_submitting_agent_cannot_challenge_its_own_submission() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    // The agent can afford the bond, so that is not why it is refused.
    let agent_before = w.token.balance(&agent);
    let held_before = w.token.balance(&w.client.address);
    assert!(agent_before >= 50 * XLM);

    assert_eq!(
        w.client.try_open_challenge(&agent, &id, &(50 * XLM)),
        Err(Ok(Error::AgentCannotChallenge))
    );
    // No tokens moved and no challenge was recorded.
    assert_eq!(w.token.balance(&agent), agent_before);
    assert_eq!(w.token.balance(&w.client.address), held_before);
    assert!(w.client.get_challenge(&id).is_none());

    // The one challenge slot is still free, and anyone else opens it as before.
    let challenger = Address::generate(&e);
    fund(&w, &challenger, 100 * XLM);
    w.client.open_challenge(&challenger, &id, &(50 * XLM));
    assert_eq!(w.token.balance(&challenger), 50 * XLM);
    assert_eq!(w.token.balance(&w.client.address), held_before + 50 * XLM);
    let chal = w.client.get_challenge(&id).unwrap();
    assert_eq!(chal.challenger, challenger);
    assert_eq!(chal.bond, 50 * XLM);
}

#[test]
fn an_agent_may_still_challenge_another_agents_submission() {
    let e = Env::default();
    let w = setup(&e);
    let (first, second) = (Address::generate(&e), Address::generate(&e));
    let first_id = submit_default(&w, &first);
    let second_id = submit_default(&w, &second);

    // Being an agent is not what is refused: challenging your own work is.
    w.client.open_challenge(&second, &first_id, &(50 * XLM));
    assert_eq!(
        w.client.get_challenge(&first_id).unwrap().challenger,
        second
    );
    assert_eq!(
        w.client
            .try_open_challenge(&second, &second_id, &(50 * XLM)),
        Err(Ok(Error::AgentCannotChallenge))
    );
}

#[test]
fn a_vote_must_agree_with_the_hash_it_reports() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let rex = Address::generate(&e);
    register_rex(&w, &rex);

    let claimed = BytesN::from_array(&e, &[3u8; 32]);
    let other = BytesN::from_array(&e, &[9u8; 32]);
    // Reporting a different output while claiming it matches, and the reverse.
    assert_eq!(
        w.client.try_attest_replay(&rex, &id, &other, &true),
        Err(Ok(Error::VoteContradictsHash))
    );
    assert_eq!(
        w.client.try_attest_replay(&rex, &id, &claimed, &false),
        Err(Ok(Error::VoteContradictsHash))
    );
    // Neither attempt was recorded, so the honest vote still goes through.
    assert_eq!(w.client.reexecutor_info(&rex).unwrap().open_attestations, 0);
    w.client.attest_replay(&rex, &id, &claimed, &true);
    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!((sub.match_votes, sub.mismatch_votes), (1, 0));
}

#[test]
fn a_no_output_vote_counts_as_a_mismatch() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    let id = submit_default(&w, &agent);
    let rex = Address::generate(&e);
    register_rex(&w, &rex);

    // What an honest re-executor reports when the function cannot be run.
    w.client.attest_replay(&rex, &id, &BytesN::from_array(&e, &[0u8; 32]), &false);
    let sub = w.client.get_submission(&id).unwrap();
    assert_eq!((sub.match_votes, sub.mismatch_votes), (0, 1));
}

#[test]
fn a_challenge_with_a_zero_bond_is_rejected_even_when_the_minimum_rounds_to_zero() {
    let e = Env::default();
    let w = setup(&e);
    let agent = Address::generate(&e);
    fund(&w, &agent, 1000 * XLM);
    // 1 stroop of escrow at 5% rounds the minimum bond down to zero.
    let id = w.client.submit(
        &agent,
        &BytesN::from_array(&e, &[1u8; 32]),
        &1,
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &1,
    );
    let challenger = Address::generate(&e);
    fund(&w, &challenger, 10 * XLM);
    assert_eq!(
        w.client.try_open_challenge(&challenger, &id, &0),
        Err(Ok(Error::BondTooLow))
    );
    assert_eq!(
        w.client.try_open_challenge(&challenger, &id, &-5),
        Err(Ok(Error::BondTooLow))
    );
    assert!(w.client.get_challenge(&id).is_none());
}
