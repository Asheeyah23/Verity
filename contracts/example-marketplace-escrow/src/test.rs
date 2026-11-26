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

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(),));
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

    let escrow_id = setup.mkt.create_escrow(
        poster,
        agent,
        &setup.token.address,
        &(1000 * XLM),
        &(1000 * XLM),
    );
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

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(),));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let agent = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&agent, &(1000 * XLM)); // agent needs its own bond for submit()

    let escrow_id = mkt.create_escrow(
        &poster,
        &agent,
        &sac.address(),
        &(1000 * XLM),
        &(1000 * XLM),
    );

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

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(),));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let agent = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&agent, &(1000 * XLM));

    let escrow_id = mkt.create_escrow(
        &poster,
        &agent,
        &sac.address(),
        &(1000 * XLM),
        &(1000 * XLM),
    );
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
        assert_eq!(stored_gate, setup.gate.address);
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

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(),));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let payee = Address::generate(&e);
    let other_agent = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&other_agent, &(1000 * XLM));

    let escrow_id = mkt.create_escrow(
        &poster,
        &payee,
        &sac.address(),
        &(1000 * XLM),
        &(1000 * XLM),
    );

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

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(),));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let payee = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&payee, &(1000 * XLM));

    let escrow_id = mkt.create_escrow(
        &poster,
        &payee,
        &sac.address(),
        &(1000 * XLM),
        &(1000 * XLM),
    );

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

    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(),));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let payee = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));
    token_admin.mint(&payee, &(1000 * XLM));

    let escrow_id = mkt.create_escrow(
        &poster,
        &payee,
        &sac.address(),
        &(1000 * XLM),
        &(1000 * XLM),
    );

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
    let mkt_id = e.register(ExampleMarketplaceEscrow, (gate_id.clone(),));
    let mkt = ExampleMarketplaceEscrowClient::new(&e, &mkt_id);

    let poster = Address::generate(&e);
    let payee = Address::generate(&e);
    token_admin.mint(&poster, &(1000 * XLM));

    let escrow_id = mkt.create_escrow(
        &poster,
        &payee,
        &sac.address(),
        &(1000 * XLM),
        &(1000 * XLM),
    );

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
            setup
                .mkt
                .try_create_escrow(&poster, &payee, &setup.token.address, &amount, &amount),
            Err(Ok(Error::InvalidAmount)),
            "{amount}"
        );
    }
    assert_eq!(setup.token.balance(&poster), 1000 * XLM);
    assert_eq!(setup.token.balance(&setup.mkt_id), 0);

    // No id was used up by the refused calls: the first real escrow is 0.
    assert_eq!(
        setup
            .mkt
            .create_escrow(&poster, &payee, &setup.token.address, &1, &1),
        0
    );
    assert_eq!(setup.token.balance(&setup.mkt_id), 1);
}

#[test]
fn create_escrow_publishes_escrow_created() {
    let setup = setup();
    let poster = Address::generate(&setup.e);
    let payee = Address::generate(&setup.e);
    setup.token_admin.mint(&poster, &(1000 * XLM));

    let first = setup.mkt.create_escrow(
        &poster,
        &payee,
        &setup.token.address,
        &(600 * XLM),
        &(600 * XLM),
    );
    let expected = EscrowCreated {
        escrow_id: first,
        poster: poster.clone(),
        payee: payee.clone(),
        token: setup.token.address.clone(),
        amount: 600 * XLM,
        escrow_value: 600 * XLM,
    }
    .to_xdr(&setup.e, &setup.mkt_id);
    assert!(setup.e.events().all().events().contains(&expected));

    // The second escrow carries its own id and amount.
    let second = setup.mkt.create_escrow(
        &poster,
        &payee,
        &setup.token.address,
        &(400 * XLM),
        &(400 * XLM),
    );
    assert_eq!((first, second), (0, 1));
    let expected = EscrowCreated {
        escrow_id: second,
        poster: poster.clone(),
        payee: payee.clone(),
        token: setup.token.address.clone(),
        amount: 400 * XLM,
        escrow_value: 400 * XLM,
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
    setup
        .mkt
        .create_escrow(&earlier, &agent, &setup.token.address, &XLM, &XLM);
    let (escrow_id, submission_id) = create_escrow_and_submission(&setup, &poster, &agent);
    assert_ne!(escrow_id, submission_id);
    let released = |to: &Address, verdict: Verdict| {
        EscrowReleased {
            escrow_id,
            submission_id,
            to: to.clone(),
            token: setup.token.address.clone(),
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
        token: setup.token.address.clone(),
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
        token: setup.token.address.clone(),
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

    let escrow_id = setup.mkt.create_escrow(
        &poster,
        &payee,
        &setup.token.address,
        &(600 * XLM),
        &(600 * XLM),
    );
    // The thresholds EscrowGate uses: extended to 500,000 ledgers.
    assert_eq!(escrow_ttl(&setup, escrow_id), 500_000);
    assert_eq!(instance_ttl(&setup), 500_000);

    // A later escrow tops the instance up again once it has decayed below
    // 100,000 ledgers, and does not touch the first escrow's record.
    setup.e.ledger().with_mut(|l| l.sequence_number += 450_000);
    assert_eq!(instance_ttl(&setup), 50_000);
    let later = setup.mkt.create_escrow(
        &poster,
        &payee,
        &setup.token.address,
        &(400 * XLM),
        &(400 * XLM),
    );
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

// ---- an escrow in a token other than the gate's bond asset ----

mod any_token {
    use super::*;
    use crate::EscrowRecord;
    use soroban_sdk::{contract, contractimpl, contracttype};

    /// A classic asset has seven decimals, USDC included.
    const USDC: i128 = 10_000_000;

    /// A second Stellar Asset Contract, standing in for USDC. EscrowGate is
    /// deployed with the other one and never hears of this.
    fn usdc(setup: &TestSetup) -> (token::Client<'static>, token::StellarAssetClient<'static>) {
        let issuer = Address::generate(&setup.e);
        let sac = setup.e.register_stellar_asset_contract_v2(issuer);
        (
            token::Client::new(&setup.e, &sac.address()),
            token::StellarAssetClient::new(&setup.e, &sac.address()),
        )
    }

    /// The payee's submission for an escrow, declaring `escrow_value` with the
    /// minimum 5% bond, which the gate takes in its own asset.
    fn submit_for(setup: &TestSetup, agent: &Address, escrow_id: u64, escrow_value: i128) -> u64 {
        setup.gate.submit(
            agent,
            &crate::escrow_ref_for(&setup.e, escrow_id),
            &escrow_value,
            &TaskType::Deterministic,
            &BytesN::from_array(&setup.e, &[2u8; 32]),
            &BytesN::from_array(&setup.e, &[3u8; 32]),
            &(escrow_value / 20),
        )
    }

    /// 250 USDC escrowed for work the poster wants bonded as 1000 XLM of
    /// value. The agent holds 1000 XLM and no USDC; the poster the reverse.
    fn usdc_escrow_and_submission(
        setup: &TestSetup,
        usdc: &token::Client,
        usdc_admin: &token::StellarAssetClient,
        poster: &Address,
        agent: &Address,
    ) -> (u64, u64) {
        usdc_admin.mint(poster, &(250 * USDC));
        setup.token_admin.mint(agent, &(1000 * XLM));
        let escrow_id =
            setup
                .mkt
                .create_escrow(poster, agent, &usdc.address, &(250 * USDC), &(1000 * XLM));
        let submission_id = submit_for(setup, agent, escrow_id, 1000 * XLM);
        (escrow_id, submission_id)
    }

    fn pass_the_window(setup: &TestSetup) {
        setup
            .e
            .ledger()
            .set_timestamp(setup.e.ledger().timestamp() + 3601);
    }

    #[test]
    fn create_escrow_holds_the_escrow_in_its_own_token_and_records_it() {
        let setup = setup();
        let (usdc, usdc_admin) = usdc(&setup);
        let poster = Address::generate(&setup.e);
        let agent = Address::generate(&setup.e);
        usdc_admin.mint(&poster, &(300 * USDC));

        let escrow_id =
            setup
                .mkt
                .create_escrow(&poster, &agent, &usdc.address, &(250 * USDC), &(1000 * XLM));
        // The event is read before any other call replaces it.
        let created = EscrowCreated {
            escrow_id,
            poster: poster.clone(),
            payee: agent.clone(),
            token: usdc.address.clone(),
            amount: 250 * USDC,
            escrow_value: 1000 * XLM,
        }
        .to_xdr(&setup.e, &setup.mkt_id);
        assert!(setup.e.events().all().events().contains(&created));

        assert_eq!(usdc.balance(&setup.mkt_id), 250 * USDC);
        assert_eq!(usdc.balance(&poster), 50 * USDC);
        // Nothing moved in the gate's asset.
        assert_eq!(setup.token.balance(&setup.mkt_id), 0);
        assert_eq!(
            setup.mkt.get_escrow(&escrow_id),
            Some(EscrowRecord {
                payee: agent,
                poster,
                token: usdc.address.clone(),
                amount: 250 * USDC,
                escrow_value: 1000 * XLM,
                released: false,
            })
        );
    }

    #[test]
    fn get_escrow_is_none_for_an_id_that_was_never_created() {
        let setup = setup();
        assert_eq!(setup.mkt.get_escrow(&0), None);
        assert_eq!(setup.mkt.get_escrow(&7), None);
    }

    #[test]
    fn a_verified_release_pays_the_payee_in_the_escrow_token() {
        let setup = setup();
        let (usdc, usdc_admin) = usdc(&setup);
        let poster = Address::generate(&setup.e);
        let agent = Address::generate(&setup.e);
        let (escrow_id, submission_id) =
            usdc_escrow_and_submission(&setup, &usdc, &usdc_admin, &poster, &agent);
        // The bond is held by the gate in the gate's asset, the escrow by the
        // marketplace in USDC.
        assert_eq!(setup.token.balance(&setup.gate.address), 50 * XLM);
        assert_eq!(usdc.balance(&setup.gate.address), 0);

        pass_the_window(&setup);
        setup.mkt.release(&escrow_id, &submission_id);
        // The event is read before any other call replaces it.
        let released = EscrowReleased {
            escrow_id,
            submission_id,
            to: agent.clone(),
            token: usdc.address.clone(),
            amount: 250 * USDC,
            verdict: Verdict::Verified,
        }
        .to_xdr(&setup.e, &setup.mkt_id);
        assert!(setup.e.events().all().events().contains(&released));

        // The payee is paid the 250 USDC and gets its 50 XLM bond back.
        assert_eq!(usdc.balance(&agent), 250 * USDC);
        assert_eq!(setup.token.balance(&agent), 1000 * XLM);
        assert_eq!(usdc.balance(&setup.mkt_id), 0);
        assert_eq!(usdc.balance(&poster), 0);
        // Neither contract ever held the other's asset.
        assert_eq!(usdc.balance(&setup.gate.address), 0);
        assert_eq!(setup.token.balance(&setup.mkt_id), 0);
        assert_eq!(setup.token.balance(&poster), 0);
        assert!(setup.mkt.get_escrow(&escrow_id).unwrap().released);

        // A second call pays nothing more.
        setup.mkt.release(&escrow_id, &submission_id);
        assert_eq!(usdc.balance(&agent), 250 * USDC);
    }

    #[test]
    fn a_slashed_release_refunds_the_poster_in_the_escrow_token() {
        let setup = setup();
        let (usdc, usdc_admin) = usdc(&setup);
        let poster = Address::generate(&setup.e);
        let agent = Address::generate(&setup.e);
        let (escrow_id, submission_id) =
            usdc_escrow_and_submission(&setup, &usdc, &usdc_admin, &poster, &agent);

        vote_mismatch(&setup, submission_id);
        setup.mkt.release(&escrow_id, &submission_id);

        assert_eq!(usdc.balance(&poster), 250 * USDC);
        assert_eq!(usdc.balance(&agent), 0);
        assert_eq!(usdc.balance(&setup.mkt_id), 0);
        // The agent's bond is forfeited at the gate, in the gate's asset.
        assert_eq!(setup.token.balance(&agent), 950 * XLM);
        assert_eq!(setup.token.balance(&poster), 0);
        assert_eq!(
            setup.gate.get_submission(&submission_id).unwrap().verdict,
            Verdict::Slashed
        );
    }

    #[test]
    fn an_expired_unverified_release_refunds_the_poster_in_the_escrow_token() {
        let setup = setup();
        let (usdc, usdc_admin) = usdc(&setup);
        let poster = Address::generate(&setup.e);
        let agent = Address::generate(&setup.e);
        let (escrow_id, submission_id) =
            usdc_escrow_and_submission(&setup, &usdc, &usdc_admin, &poster, &agent);

        // One mismatch vote, short of a quorum, and the window closes.
        let rex = Address::generate(&setup.e);
        setup.token_admin.mint(&rex, &(2000 * XLM));
        setup.gate.register_reexecutor(&rex, &(600 * XLM));
        setup.gate.attest_replay(
            &rex,
            &submission_id,
            &BytesN::from_array(&setup.e, &[9u8; 32]),
            &false,
        );
        pass_the_window(&setup);
        setup.mkt.release(&escrow_id, &submission_id);

        assert_eq!(usdc.balance(&poster), 250 * USDC);
        assert_eq!(usdc.balance(&agent), 0);
        // Nobody was proven wrong, so the agent's bond comes back.
        assert_eq!(setup.token.balance(&agent), 1000 * XLM);
        assert_eq!(
            setup.gate.get_submission(&submission_id).unwrap().verdict,
            Verdict::ExpiredUnverified
        );
    }

    #[test]
    fn the_gate_sizes_the_bond_from_the_escrow_value_not_from_the_token_amount() {
        let setup = setup();
        let (usdc, usdc_admin) = usdc(&setup);
        let poster = Address::generate(&setup.e);
        let agent = Address::generate(&setup.e);
        usdc_admin.mint(&poster, &(250 * USDC));
        setup.token_admin.mint(&agent, &(1000 * XLM));
        let escrow_id =
            setup
                .mkt
                .create_escrow(&poster, &agent, &usdc.address, &(250 * USDC), &(1000 * XLM));

        // 5% of the 250-unit amount would be 12.5. The gate asks for 5% of the
        // 1000 the escrow declares, so 49 is refused and 50 is accepted.
        let submit = |bond: i128| {
            setup.gate.try_submit(
                &agent,
                &crate::escrow_ref_for(&setup.e, escrow_id),
                &(1000 * XLM),
                &TaskType::Deterministic,
                &BytesN::from_array(&setup.e, &[2u8; 32]),
                &BytesN::from_array(&setup.e, &[3u8; 32]),
                &bond,
            )
        };
        assert_eq!(submit(49 * XLM), Err(Ok(Error::BondTooLow)));
        let submission_id = submit(50 * XLM).unwrap().unwrap();

        pass_the_window(&setup);
        setup.mkt.release(&escrow_id, &submission_id);
        assert_eq!(usdc.balance(&agent), 250 * USDC);
    }

    #[test]
    fn release_refuses_a_submission_that_declares_the_token_amount_as_its_value() {
        let setup = setup();
        let (usdc, usdc_admin) = usdc(&setup);
        let poster = Address::generate(&setup.e);
        let agent = Address::generate(&setup.e);
        usdc_admin.mint(&poster, &(250 * USDC));
        setup.token_admin.mint(&agent, &(1000 * XLM));
        let escrow_id =
            setup
                .mkt
                .create_escrow(&poster, &agent, &usdc.address, &(250 * USDC), &(1000 * XLM));
        // The agent bonds for 250 of value, a quarter of what the poster asked.
        let submission_id = submit_for(&setup, &agent, escrow_id, 250 * USDC);

        pass_the_window(&setup);
        assert_eq!(
            setup.mkt.try_release(&escrow_id, &submission_id),
            Err(Ok(Error::InvalidEscrowValue))
        );
        // Nothing was paid, and the submission was not finalized on the way.
        assert_eq!(usdc.balance(&setup.mkt_id), 250 * USDC);
        assert_eq!(usdc.balance(&agent), 0);
        assert!(!setup.mkt.get_escrow(&escrow_id).unwrap().released);
        assert_eq!(
            setup.gate.get_submission(&submission_id).unwrap().verdict,
            Verdict::Pending
        );
    }

    #[test]
    fn two_escrows_in_two_tokens_are_each_paid_in_their_own() {
        let setup = setup();
        let (usdc, usdc_admin) = usdc(&setup);
        let poster = Address::generate(&setup.e);
        let agent = Address::generate(&setup.e);
        usdc_admin.mint(&poster, &(250 * USDC));
        setup.token_admin.mint(&poster, &(400 * XLM));
        setup.token_admin.mint(&agent, &(1000 * XLM));

        let in_usdc =
            setup
                .mkt
                .create_escrow(&poster, &agent, &usdc.address, &(250 * USDC), &(1000 * XLM));
        let in_xlm = setup.mkt.create_escrow(
            &poster,
            &agent,
            &setup.token.address,
            &(400 * XLM),
            &(400 * XLM),
        );
        assert_eq!(usdc.balance(&setup.mkt_id), 250 * USDC);
        assert_eq!(setup.token.balance(&setup.mkt_id), 400 * XLM);
        let for_usdc = submit_for(&setup, &agent, in_usdc, 1000 * XLM);
        let for_xlm = submit_for(&setup, &agent, in_xlm, 400 * XLM);

        pass_the_window(&setup);
        setup.mkt.release(&in_xlm, &for_xlm);
        // The other escrow is untouched by this release.
        assert_eq!(usdc.balance(&setup.mkt_id), 250 * USDC);
        assert_eq!(usdc.balance(&agent), 0);
        assert_eq!(setup.token.balance(&setup.mkt_id), 0);

        setup.mkt.release(&in_usdc, &for_usdc);
        assert_eq!(usdc.balance(&agent), 250 * USDC);
        // 1000 XLM to start with, both bonds returned, and the 400 XLM escrow.
        assert_eq!(setup.token.balance(&agent), 1400 * XLM);
        assert_eq!(usdc.balance(&setup.mkt_id), 0);
    }

    #[test]
    fn create_escrow_rejects_a_zero_or_negative_escrow_value_and_moves_nothing() {
        let setup = setup();
        let (usdc, usdc_admin) = usdc(&setup);
        let poster = Address::generate(&setup.e);
        let agent = Address::generate(&setup.e);
        usdc_admin.mint(&poster, &(250 * USDC));

        for escrow_value in [0, -1, i128::MIN] {
            assert_eq!(
                setup.mkt.try_create_escrow(
                    &poster,
                    &agent,
                    &usdc.address,
                    &(250 * USDC),
                    &escrow_value
                ),
                Err(Ok(Error::InvalidEscrowValue))
            );
        }
        assert_eq!(usdc.balance(&poster), 250 * USDC);
        assert_eq!(usdc.balance(&setup.mkt_id), 0);
        // No id was used up.
        assert_eq!(setup.mkt.get_escrow(&0), None);
        assert_eq!(
            setup
                .mkt
                .create_escrow(&poster, &agent, &usdc.address, &(250 * USDC), &1),
            0
        );
    }

    #[contracttype]
    enum TokenKey {
        Balance(Address),
        Refused(Address),
    }

    /// A token that can be told to refuse payments to one address, the way a
    /// classic asset's contract refuses an account that has no trustline to
    /// it. It stands in for that case: this test host has no way to give an
    /// account a trustline to one asset and not to another.
    #[contract]
    struct RefusingToken;

    #[contractimpl]
    impl RefusingToken {
        pub fn mint(e: Env, to: Address, amount: i128) {
            let key = TokenKey::Balance(to);
            let balance: i128 = e.storage().persistent().get(&key).unwrap_or(0);
            e.storage().persistent().set(&key, &(balance + amount));
        }

        pub fn set_refused(e: Env, who: Address, refused: bool) {
            let key = TokenKey::Refused(who);
            if refused {
                e.storage().persistent().set(&key, &true);
            } else {
                e.storage().persistent().remove(&key);
            }
        }

        pub fn balance(e: Env, id: Address) -> i128 {
            e.storage()
                .persistent()
                .get(&TokenKey::Balance(id))
                .unwrap_or(0)
        }

        pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();
            if e.storage().persistent().has(&TokenKey::Refused(to.clone())) {
                panic!("the receiver cannot hold this token");
            }
            let from_key = TokenKey::Balance(from);
            let to_key = TokenKey::Balance(to);
            let from_balance: i128 = e.storage().persistent().get(&from_key).unwrap_or(0);
            let to_balance: i128 = e.storage().persistent().get(&to_key).unwrap_or(0);
            assert!(from_balance >= amount, "balance too low");
            e.storage()
                .persistent()
                .set(&from_key, &(from_balance - amount));
            e.storage()
                .persistent()
                .set(&to_key, &(to_balance + amount));
        }
    }

    #[test]
    fn a_release_whose_payment_is_refused_fails_as_a_whole_and_can_be_repeated() {
        let setup = setup();
        let token_id = setup.e.register(RefusingToken, ());
        let refusing = RefusingTokenClient::new(&setup.e, &token_id);
        let poster = Address::generate(&setup.e);
        let agent = Address::generate(&setup.e);
        refusing.mint(&poster, &250);
        setup.token_admin.mint(&agent, &(1000 * XLM));
        let escrow_id = setup
            .mkt
            .create_escrow(&poster, &agent, &token_id, &250, &(1000 * XLM));
        let submission_id = submit_for(&setup, &agent, escrow_id, 1000 * XLM);
        assert_eq!(refusing.balance(&setup.mkt_id), 250);

        // The window closes with the work unchallenged, so the verdict would be
        // Verified, but the payee cannot be paid.
        pass_the_window(&setup);
        refusing.set_refused(&agent, &true);
        assert!(setup.mkt.try_release(&escrow_id, &submission_id).is_err());

        // Nothing half-happened: the escrow is still held and unreleased, and
        // the finalize() inside the failed call was undone with it, so the
        // agent's bond is still at the gate.
        assert_eq!(refusing.balance(&setup.mkt_id), 250);
        assert_eq!(refusing.balance(&agent), 0);
        assert!(!setup.mkt.get_escrow(&escrow_id).unwrap().released);
        assert_eq!(
            setup.gate.get_submission(&submission_id).unwrap().verdict,
            Verdict::Pending
        );
        assert_eq!(setup.token.balance(&agent), 950 * XLM);

        // Once the payee can hold the token, the same call goes through.
        refusing.set_refused(&agent, &false);
        setup.mkt.release(&escrow_id, &submission_id);
        assert_eq!(refusing.balance(&agent), 250);
        assert_eq!(refusing.balance(&setup.mkt_id), 0);
        assert!(setup.mkt.get_escrow(&escrow_id).unwrap().released);
        assert_eq!(setup.token.balance(&agent), 1000 * XLM);
    }

    #[test]
    fn a_refused_refund_fails_as_a_whole_too() {
        let setup = setup();
        let token_id = setup.e.register(RefusingToken, ());
        let refusing = RefusingTokenClient::new(&setup.e, &token_id);
        let poster = Address::generate(&setup.e);
        let agent = Address::generate(&setup.e);
        refusing.mint(&poster, &250);
        setup.token_admin.mint(&agent, &(1000 * XLM));
        let escrow_id = setup
            .mkt
            .create_escrow(&poster, &agent, &token_id, &250, &(1000 * XLM));
        let submission_id = submit_for(&setup, &agent, escrow_id, 1000 * XLM);

        vote_mismatch(&setup, submission_id);
        refusing.set_refused(&poster, &true);
        assert!(setup.mkt.try_release(&escrow_id, &submission_id).is_err());
        assert_eq!(refusing.balance(&setup.mkt_id), 250);
        assert!(!setup.mkt.get_escrow(&escrow_id).unwrap().released);

        refusing.set_refused(&poster, &false);
        setup.mkt.release(&escrow_id, &submission_id);
        assert_eq!(refusing.balance(&poster), 250);
        assert_eq!(refusing.balance(&agent), 0);
    }
}
