#![cfg(test)]

use crate::events::{EscrowCreated, EscrowReleased};
use crate::{DataKey, ExampleMarketplaceEscrow, ExampleMarketplaceEscrowClient};
use escrow_gate::{EscrowGate, EscrowGateClient};
use soroban_sdk::{
    events::Event as _,
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Events as _, Ledger as _,
    },
    token, Address, BytesN, Env,
};
use verity_common::{ConfigRecord, Error, TaskType, Verdict};

const XLM: i128 = 10_000_000;

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

struct TestSetup {
    e: Env,
    token: token::Client<'static>,
    token_admin: token::StellarAssetClient<'static>,
    gate: EscrowGateClient<'static>,
    mkt: ExampleMarketplaceEscrowClient<'static>,
    mkt_id: Address,
}

fn setup() -> TestSetup {
    let e = Env::default();
    e.mock_all_auths();

    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let gate_id = e.register(EscrowGate, (admin.clone(), sac.address(), default_config()));
    let gate = EscrowGateClient::new(&e, &gate_id);

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(), sac.address()));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    TestSetup {
        e,
        token,
        token_admin,
        gate,
        mkt,
        mkt_id,
    }
}

fn create_escrow_and_submission(
    setup: &TestSetup,
    poster: &Address,
    agent: &Address,
) -> (u64, u64) {
    setup.token_admin.mint(poster, &(1000 * XLM));
    setup.token_admin.mint(agent, &(1000 * XLM));

    let escrow_id = setup.mkt.create_escrow(poster, agent, &(1000 * XLM));
    let submission_id = setup.gate.submit(
        agent,
        &crate::escrow_ref_for(&setup.e, escrow_id),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&setup.e, &[2u8; 32]),
        &BytesN::from_array(&setup.e, &[3u8; 32]),
        &(50 * XLM),
    );
    (escrow_id, submission_id)
}

#[test]
fn release_pays_agent_only_after_gate_verifies() {
    let e = Env::default();
    e.mock_all_auths();

    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let gate_id = e.register(EscrowGate, (admin.clone(), sac.address(), default_config()));
    let gate = EscrowGateClient::new(&e, &gate_id);

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(), sac.address()));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let agent = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&agent, &(1000 * XLM)); // agent needs its own bond for submit()

    let escrow_id = mkt.create_escrow(&poster, &agent, &(1000 * XLM));

    let submission_id = gate.submit(
        &agent,
        &crate::escrow_ref_for(&e, escrow_id),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );

    // Before the window elapses and with no consensus yet, release() must
    // refuse to pay out — this is the whole point of gating on finalize().
    let res = mkt.try_release(&escrow_id, &submission_id);
    assert!(res.is_err());
    assert_eq!(token.balance(&agent), 950 * XLM);

    e.ledger().set_timestamp(e.ledger().timestamp() + 3601);
    mkt.release(&escrow_id, &submission_id);

    // Agent gets both their returned Verity bond AND the marketplace's own
    // escrowed bounty payout.
    assert_eq!(token.balance(&agent), 950 * XLM + 50 * XLM + 1000 * XLM);
    assert_eq!(token.balance(&mkt_id), 0);

    // Idempotent on the marketplace side too.
    mkt.release(&escrow_id, &submission_id);
    assert_eq!(token.balance(&agent), 950 * XLM + 50 * XLM + 1000 * XLM);
}

#[test]
fn release_refunds_poster_when_gate_slashes() {
    let e = Env::default();
    e.mock_all_auths();

    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let gate_id = e.register(EscrowGate, (admin.clone(), sac.address(), default_config()));
    let gate = EscrowGateClient::new(&e, &gate_id);

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(), sac.address()));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let agent = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&agent, &(1000 * XLM));

    let escrow_id = mkt.create_escrow(&poster, &agent, &(1000 * XLM));
    let submission_id = gate.submit(
        &agent,
        &crate::escrow_ref_for(&e, escrow_id),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );

    let rex1 = Address::generate(&e);
    let rex2 = Address::generate(&e);
    let rex3 = Address::generate(&e);
    for r in [&rex1, &rex2, &rex3] {
        token_admin.mint(r, &(2000 * XLM));
        gate.register_reexecutor(r, &(600 * XLM));
        gate.attest_replay(r, &submission_id, &BytesN::from_array(&e, &[9u8; 32]), &false);
    }

    mkt.release(&escrow_id, &submission_id);
    // Bounty returns to the poster, not the agent, on a Slashed verdict.
    assert_eq!(token.balance(&poster), 1000 * XLM);
    assert_eq!(token.balance(&agent), 950 * XLM); // never got the Verity bond back either
}

#[test]
fn release_refunds_poster_on_expired_unverified() {
    let setup = setup();
    let poster = Address::generate(&setup.e);
    let agent = Address::generate(&setup.e);
    let (escrow_id, submission_id) = create_escrow_and_submission(&setup, &poster, &agent);

    // One re-executor votes mismatch.
    let rex = Address::generate(&setup.e);
    setup.token_admin.mint(&rex, &(2000 * XLM));
    setup.gate.register_reexecutor(&rex, &(600 * XLM));
    setup.gate.attest_replay(
        &rex,
        &submission_id,
        &BytesN::from_array(&setup.e, &[9u8; 32]),
        &false,
    );

    // Window elapses.
    setup.e.ledger().set_timestamp(setup.e.ledger().timestamp() + 3601);
    setup.mkt.release(&escrow_id, &submission_id);

    // Poster gets the full escrow amount back.
    assert_eq!(setup.token.balance(&poster), 1000 * XLM);
    // Agent gets only their Verity bond back (950 left after bond + 50 returned).
    assert_eq!(setup.token.balance(&agent), 1000 * XLM);
    // Marketplace holds nothing.
    assert_eq!(setup.token.balance(&setup.mkt_id), 0);
}

#[test]
fn constructor_arguments_are_stored() {
    let setup = setup();
    setup.e.as_contract(&setup.mkt_id, || {
        let stored_gate: Address = setup.e.storage().instance().get(&DataKey::Gate).unwrap();
        let stored_token: Address = setup.e.storage().instance().get(&DataKey::BondAsset).unwrap();
        assert_eq!(stored_gate, setup.gate.address);
        assert_eq!(stored_token, setup.token.address);
    });
}

#[test]
fn release_unknown_escrow_returns_submission_not_found() {
    let setup = setup();
    let res = setup.mkt.try_release(&999u64, &0u64);
    assert_eq!(res, Err(Ok(Error::SubmissionNotFound)));
}

#[test]
fn release_before_window_elapsed_refuses_and_allows_later() {
    let setup = setup();
    let poster = Address::generate(&setup.e);
    let agent = Address::generate(&setup.e);
    let (escrow_id, submission_id) = create_escrow_and_submission(&setup, &poster, &agent);

    let agent_balance_before = setup.token.balance(&agent);

    // Early release must fail with ChallengeWindowNotElapsed and move no funds.
    let res = setup.mkt.try_release(&escrow_id, &submission_id);
    assert_eq!(res, Err(Ok(Error::ChallengeWindowNotElapsed)));
    assert_eq!(setup.token.balance(&agent), agent_balance_before);
    assert_eq!(setup.token.balance(&setup.mkt_id), 1000 * XLM);

    // After the window elapses, release succeeds and pays the payee.
    setup.e.ledger().set_timestamp(setup.e.ledger().timestamp() + 3601);
    setup.mkt.release(&escrow_id, &submission_id);
    assert_eq!(
        setup.token.balance(&agent),
        agent_balance_before + 50 * XLM + 1000 * XLM
    );
    assert_eq!(setup.token.balance(&setup.mkt_id), 0);
}

#[test]
fn release_rejects_submission_from_other_agent() {
    let e = Env::default();
    e.mock_all_auths();

    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let gate_id = e.register(EscrowGate, (admin.clone(), sac.address(), default_config()));
    let gate = EscrowGateClient::new(&e, &gate_id);

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(), sac.address()));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let payee = Address::generate(&e);
    let other_agent = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&other_agent, &(1000 * XLM));

    let escrow_id = mkt.create_escrow(&poster, &payee, &(1000 * XLM));

    // A valid, matching-escrow submission that simply belongs to a different
    // agent must not release this escrow.
    let submission_id = gate.submit(
        &other_agent,
        &crate::escrow_ref_for(&e, escrow_id),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );

    let res = mkt.try_release(&escrow_id, &submission_id);
    assert_eq!(res, Err(Ok(Error::SubmissionNotFound)));
    assert_eq!(token.balance(&payee), 0);
    assert_eq!(token.balance(&mkt_id), 1000 * XLM);
    // The rejected submission was not finalized as a side effect.
    assert!(!gate.get_submission(&submission_id).unwrap().finalized);
}

#[test]
fn release_rejects_mismatched_escrow_value() {
    let e = Env::default();
    e.mock_all_auths();

    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let gate_id = e.register(EscrowGate, (admin.clone(), sac.address(), default_config()));
    let gate = EscrowGateClient::new(&e, &gate_id);

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(), sac.address()));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let payee = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&payee, &(1000 * XLM));

    let escrow_id = mkt.create_escrow(&poster, &payee, &(1000 * XLM));

    // Right agent and escrow_ref, but the claimed value does not match the
    // escrow's amount.
    let submission_id = gate.submit(
        &payee,
        &crate::escrow_ref_for(&e, escrow_id),
        &(10 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &XLM,
    );

    let payee_before = token.balance(&payee);
    let res = mkt.try_release(&escrow_id, &submission_id);
    assert_eq!(res, Err(Ok(Error::InvalidEscrowValue)));
    assert_eq!(token.balance(&payee), payee_before);
    assert_eq!(token.balance(&mkt_id), 1000 * XLM);
    assert!(!gate.get_submission(&submission_id).unwrap().finalized);
}

#[test]
fn release_rejects_mismatched_escrow_ref() {
    let e = Env::default();
    e.mock_all_auths();

    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let gate_id = e.register(EscrowGate, (admin.clone(), sac.address(), default_config()));
    let gate = EscrowGateClient::new(&e, &gate_id);

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(), sac.address()));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let payee = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&payee, &(1000 * XLM));

    let escrow_id = mkt.create_escrow(&poster, &payee, &(1000 * XLM));

    // Right agent and value, but the submission names a different escrow.
    let submission_id = gate.submit(
        &payee,
        &BytesN::from_array(&e, &[1u8; 32]),
        &(1000 * XLM),
        &TaskType::Deterministic,
        &BytesN::from_array(&e, &[2u8; 32]),
        &BytesN::from_array(&e, &[3u8; 32]),
        &(50 * XLM),
    );

    let payee_before = token.balance(&payee);
    let res = mkt.try_release(&escrow_id, &submission_id);
    assert_eq!(res, Err(Ok(Error::SubmissionNotFound)));
    assert_eq!(token.balance(&payee), payee_before);
    assert_eq!(token.balance(&mkt_id), 1000 * XLM);
    assert!(!gate.get_submission(&submission_id).unwrap().finalized);
}

#[test]
fn release_rejects_unknown_submission() {
    let e = Env::default();
    e.mock_all_auths();

    let admin = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let token = token::Client::new(&e, &sac.address());
    let token_admin = token::StellarAssetClient::new(&e, &sac.address());

    let gate_id = e.register(EscrowGate, (admin.clone(), sac.address(), default_config()));
    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(), sac.address()));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let payee = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));

    let escrow_id = mkt.create_escrow(&poster, &payee, &(1000 * XLM));

    let res = mkt.try_release(&escrow_id, &99u64);
    assert_eq!(res, Err(Ok(Error::SubmissionNotFound)));
    assert_eq!(token.balance(&mkt_id), 1000 * XLM);
}

// ---- amounts, events and storage TTLs ----

fn escrow_ttl(setup: &TestSetup, escrow_id: u64) -> u32 {
    setup.e.as_contract(&setup.mkt_id, || {
        setup
            .e
            .storage()
            .persistent()
            .get_ttl(&crate::DataKey::Escrow(escrow_id))
    })
}

fn instance_ttl(setup: &TestSetup) -> u32 {
    setup
        .e
        .as_contract(&setup.mkt_id, || setup.e.storage().instance().get_ttl())
}

/// Three re-executors vote mismatch, which is a slashing consensus.
fn vote_mismatch(setup: &TestSetup, submission_id: u64) {
    for _ in 0..3 {
        let rex = Address::generate(&setup.e);
        setup.token_admin.mint(&rex, &(2000 * XLM));
        setup.gate.register_reexecutor(&rex, &(600 * XLM));
        setup.gate.attest_replay(
            &rex,
            &submission_id,
            &BytesN::from_array(&setup.e, &[9u8; 32]),
            &false,
        );
    }
}

#[test]
fn create_escrow_rejects_a_zero_or_negative_amount_and_moves_nothing() {
    let setup = setup();
    let poster = Address::generate(&setup.e);
    let payee = Address::generate(&setup.e);
    setup.token_admin.mint(&poster, &(1000 * XLM));

    for amount in [0, -1, -(1000 * XLM)] {
        assert_eq!(
            setup.mkt.try_create_escrow(&poster, &payee, &amount),
            Err(Ok(Error::InvalidAmount)),
            "{amount}"
        );
    }
    assert_eq!(setup.token.balance(&poster), 1000 * XLM);
    assert_eq!(setup.token.balance(&setup.mkt_id), 0);

    // No id was used up by the refused calls: the first real escrow is 0.
    assert_eq!(setup.mkt.create_escrow(&poster, &payee, &1), 0);
    assert_eq!(setup.token.balance(&setup.mkt_id), 1);
}

#[test]
fn create_escrow_publishes_escrow_created() {
    let setup = setup();
    let poster = Address::generate(&setup.e);
    let payee = Address::generate(&setup.e);
    setup.token_admin.mint(&poster, &(1000 * XLM));

    let first = setup.mkt.create_escrow(&poster, &payee, &(600 * XLM));
    let expected = EscrowCreated {
        escrow_id: first,
        poster: poster.clone(),
        payee: payee.clone(),
        amount: 600 * XLM,
    }
    .to_xdr(&setup.e, &setup.mkt_id);
    assert!(setup.e.events().all().events().contains(&expected));

    // The second escrow carries its own id and amount.
    let second = setup.mkt.create_escrow(&poster, &payee, &(400 * XLM));
    assert_eq!((first, second), (0, 1));
    let expected = EscrowCreated {
        escrow_id: second,
        poster: poster.clone(),
        payee: payee.clone(),
        amount: 400 * XLM,
    }
    .to_xdr(&setup.e, &setup.mkt_id);
    assert!(setup.e.events().all().events().contains(&expected));
}

#[test]
fn release_publishes_escrow_released_to_the_payee_when_verified() {
    let setup = setup();
    let poster = Address::generate(&setup.e);
    let agent = Address::generate(&setup.e);
    // An earlier escrow, so that the escrow and the submission below do not
    // share an id and the event cannot swap them unnoticed.
    let earlier = Address::generate(&setup.e);
    setup.token_admin.mint(&earlier, &XLM);
    setup.mkt.create_escrow(&earlier, &agent, &XLM);
    let (escrow_id, submission_id) = create_escrow_and_submission(&setup, &poster, &agent);
    assert_ne!(escrow_id, submission_id);
    let released = |to: &Address, verdict: Verdict| {
        EscrowReleased {
            escrow_id,
            submission_id,
            to: to.clone(),
            amount: 1000 * XLM,
            verdict,
        }
        .to_xdr(&setup.e, &setup.mkt_id)
    };

    // A release that is refused publishes nothing.
    assert_eq!(
        setup.mkt.try_release(&escrow_id, &submission_id),
        Err(Ok(Error::ChallengeWindowNotElapsed))
    );
    let to_agent = released(&agent, Verdict::Verified);
    let to_poster = released(&poster, Verdict::Verified);
    assert!(!setup.e.events().all().events().contains(&to_agent));

    setup
        .e
        .ledger()
        .set_timestamp(setup.e.ledger().timestamp() + 3601);
    setup.mkt.release(&escrow_id, &submission_id);
    let events = setup.e.events().all();
    assert!(events.events().contains(&to_agent));
    assert!(!events.events().contains(&to_poster));
}

#[test]
fn release_publishes_escrow_released_to_the_poster_when_slashed() {
    let setup = setup();
    let poster = Address::generate(&setup.e);
    let agent = Address::generate(&setup.e);
    let (escrow_id, submission_id) = create_escrow_and_submission(&setup, &poster, &agent);
    vote_mismatch(&setup, submission_id);

    setup.mkt.release(&escrow_id, &submission_id);
    let expected = EscrowReleased {
        escrow_id,
        submission_id,
        to: poster.clone(),
        amount: 1000 * XLM,
        verdict: Verdict::Slashed,
    }
    .to_xdr(&setup.e, &setup.mkt_id);
    assert!(setup.e.events().all().events().contains(&expected));
    assert_eq!(setup.token.balance(&poster), 1000 * XLM);
}

#[test]
fn release_publishes_escrow_released_to_the_poster_when_expired_unverified() {
    let setup = setup();
    let poster = Address::generate(&setup.e);
    let agent = Address::generate(&setup.e);
    let (escrow_id, submission_id) = create_escrow_and_submission(&setup, &poster, &agent);

    // One mismatch vote and no quorum: the window closes with nothing established.
    let rex = Address::generate(&setup.e);
    setup.token_admin.mint(&rex, &(2000 * XLM));
    setup.gate.register_reexecutor(&rex, &(600 * XLM));
    setup.gate.attest_replay(
        &rex,
        &submission_id,
        &BytesN::from_array(&setup.e, &[9u8; 32]),
        &false,
    );
    setup
        .e
        .ledger()
        .set_timestamp(setup.e.ledger().timestamp() + 3601);

    setup.mkt.release(&escrow_id, &submission_id);
    let expected = EscrowReleased {
        escrow_id,
        submission_id,
        to: poster.clone(),
        amount: 1000 * XLM,
        verdict: Verdict::ExpiredUnverified,
    }
    .to_xdr(&setup.e, &setup.mkt_id);
    assert!(setup.e.events().all().events().contains(&expected));
}

#[test]
fn create_escrow_extends_the_record_and_the_instance() {
    let setup = setup();
    let poster = Address::generate(&setup.e);
    let payee = Address::generate(&setup.e);
    setup.token_admin.mint(&poster, &(1000 * XLM));

    let escrow_id = setup.mkt.create_escrow(&poster, &payee, &(600 * XLM));
    // The thresholds EscrowGate uses: extended to 500,000 ledgers.
    assert_eq!(escrow_ttl(&setup, escrow_id), 500_000);
    assert_eq!(instance_ttl(&setup), 500_000);

    // A later escrow tops the instance up again once it has decayed below
    // 100,000 ledgers, and does not touch the first escrow's record.
    setup.e.ledger().with_mut(|l| l.sequence_number += 450_000);
    assert_eq!(instance_ttl(&setup), 50_000);
    let later = setup.mkt.create_escrow(&poster, &payee, &(400 * XLM));
    assert_eq!(instance_ttl(&setup), 500_000);
    assert_eq!(escrow_ttl(&setup, later), 500_000);
    assert_eq!(escrow_ttl(&setup, escrow_id), 50_000);
}

#[test]
fn release_extends_the_record_and_the_instance() {
    let setup = setup();
    let poster = Address::generate(&setup.e);
    let agent = Address::generate(&setup.e);
    let (escrow_id, submission_id) = create_escrow_and_submission(&setup, &poster, &agent);

    // The bounty waits a long time: both TTLs decay below the threshold.
    setup.e.ledger().with_mut(|l| l.sequence_number += 450_000);
    setup
        .e
        .ledger()
        .set_timestamp(setup.e.ledger().timestamp() + 3601);
    assert_eq!(escrow_ttl(&setup, escrow_id), 50_000);
    assert_eq!(instance_ttl(&setup), 50_000);

    setup.mkt.release(&escrow_id, &submission_id);
    assert_eq!(escrow_ttl(&setup, escrow_id), 500_000);
    assert_eq!(instance_ttl(&setup), 500_000);
    assert_eq!(setup.token.balance(&agent), 2000 * XLM);
}
