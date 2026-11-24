#![no_std]

//! Reference contract only — demonstrates the drop-in wrapper pattern any real
//! marketplace's own escrow contract uses to gate its `release()` on Verity's
//! `EscrowGate.finalize()` before paying an agent. Not deployed as part of
//! Verity's own stack; shipped as integration documentation an external
//! integrator can copy the pattern from (Rust) or reimplement against the
//! exported EscrowGate contract spec (any language via stellar-sdk bindings).
//!
//! The contract is initialized atomically at deployment via `__constructor`,
//! fixing the Verity `EscrowGate` and payment token addresses so setup cannot
//! be front-run.

mod events;

use events::{EscrowCreated, EscrowReleased};
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};
use verity_common::{Error, SubmissionRecord, Verdict};

#[contracttype]
#[derive(Clone)]
pub(crate) enum DataKey {
    Gate,
    BondAsset,
    Escrow(u64),
    NextId,
}

#[contracttype]
#[derive(Clone)]
struct EscrowRecord {
    payee: Address,
    poster: Address,
    amount: i128,
    released: bool,
}

// The thresholds EscrowGate uses (contracts/escrow-gate/src/storage.rs). An
// entry is extended whenever it is written, so a bounty that waits weeks for
// work does not have its record archived before release() needs it.
const BUMP_THRESHOLD: u32 = 100_000;
const BUMP_TO: u32 = 500_000;

/// Extends an escrow's record and the instance. The instance holds the gate,
/// the token and the id counter, and its TTL also covers the contract code.
fn bump(e: &Env, escrow_id: u64) {
    e.storage()
        .persistent()
        .extend_ttl(&DataKey::Escrow(escrow_id), BUMP_THRESHOLD, BUMP_TO);
    e.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

#[contract]
pub struct ExampleMarketplaceEscrow;

/// `escrow_ref` for escrow `N` is the 32-byte value with all bytes zero except
/// the last 8, which hold `N` as a big-endian `u64`. This is the convention a
/// marketplace and its submitters agree on so a submission can be bound to the
/// escrow it names; a submission must carry it for its escrow to be releasable.
fn escrow_ref_for(e: &Env, escrow_id: u64) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[24..32].copy_from_slice(&escrow_id.to_be_bytes());
    BytesN::from_array(e, &bytes)
}

#[contractimpl]
impl ExampleMarketplaceEscrow {
    /// Runs once, atomically with deployment, so nobody can front-run the contract
    /// setup by claiming a fake gate or token.
    pub fn __constructor(e: Env, gate: Address, token: Address) {
        e.storage().instance().set(&DataKey::Gate, &gate);
        e.storage().instance().set(&DataKey::BondAsset, &token);
    }

    /// The bounty poster escrows funds for a specific payee agent, unrelated
    /// to (and pre-dating) any Verity submission — this is the marketplace's
    /// own existing escrow behavior, unchanged by integrating Verity.
    pub fn create_escrow(e: Env, poster: Address, payee: Address, amount: i128) -> Result<u64, Error> {
        poster.require_auth();
        // An escrow of zero could never be released: EscrowGate refuses a
        // submission with no escrow value, and release() needs the two amounts
        // to be equal. A negative one would only fail later, inside the token
        // transfer, with a host error. Both are refused here, before anything
        // moves.
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let bond_asset: Address = e
            .storage()
            .instance()
            .get(&DataKey::BondAsset)
            .ok_or(Error::NotInitialized)?;
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        token.transfer(&poster, e.current_contract_address(), &amount);

        let id: u64 = e.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        e.storage().instance().set(&DataKey::NextId, &(id + 1));
        e.storage().persistent().set(
            &DataKey::Escrow(id),
            &EscrowRecord {
                payee: payee.clone(),
                poster: poster.clone(),
                amount,
                released: false,
            },
        );
        bump(&e, id);

        EscrowCreated {
            escrow_id: id,
            poster,
            payee,
            amount,
        }
        .publish(&e);
        Ok(id)
    }

    /// The one line a real marketplace adds to its own release() path:
    /// gate `finalize()` before paying out. Verdict::Verified pays the agent;
    /// Slashed/ExpiredUnverified returns funds to the bounty poster instead;
    /// Pending/Disputed simply refuse to release yet.
    pub fn release(e: Env, escrow_id: u64, submission_id: u64) -> Result<(), Error> {
        let mut rec: EscrowRecord = e
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::SubmissionNotFound)?;
        if rec.released {
            return Ok(());
        }
        let gate: Address = e
            .storage()
            .instance()
            .get(&DataKey::Gate)
            .ok_or(Error::NotInitialized)?;

        // Bind the named submission to this escrow before finalizing it.
        // Otherwise any submission that verifies (or gets slashed) could
        // release any escrow: the verdict alone says nothing about which
        // escrow the work was for. A mismatch must not reach `finalize`, so a
        // wrong submission is not finalized (and its bonds not moved) as a
        // side effect of a failed release attempt.
        let submission: Option<SubmissionRecord> = e.invoke_contract(
            &gate,
            &soroban_sdk::Symbol::new(&e, "get_submission"),
            soroban_sdk::vec![&e, soroban_sdk::IntoVal::into_val(&submission_id, &e)],
        );
        let submission = submission.ok_or(Error::SubmissionNotFound)?;
        if submission.agent != rec.payee || submission.escrow_ref != escrow_ref_for(&e, escrow_id) {
            return Err(Error::SubmissionNotFound);
        }
        if submission.escrow_value != rec.amount {
            return Err(Error::InvalidEscrowValue);
        }

        let verdict: Verdict = e.invoke_contract(
            &gate,
            &soroban_sdk::Symbol::new(&e, "finalize"),
            soroban_sdk::vec![&e, soroban_sdk::IntoVal::into_val(&submission_id, &e)],
        );

        let bond_asset: Address = e
            .storage()
            .instance()
            .get(&DataKey::BondAsset)
            .ok_or(Error::NotInitialized)?;
        let token = soroban_sdk::token::TokenClient::new(&e, &bond_asset);
        let contract_address = e.current_contract_address();

        let to = match verdict {
            Verdict::Verified => rec.payee.clone(),
            Verdict::Slashed | Verdict::ExpiredUnverified => rec.poster.clone(),
            Verdict::Pending | Verdict::Disputed => {
                return Err(Error::ChallengeWindowNotElapsed);
            }
        };
        token.transfer(&contract_address, to.clone(), &rec.amount);
        rec.released = true;
        e.storage().persistent().set(&DataKey::Escrow(escrow_id), &rec);
        bump(&e, escrow_id);

        EscrowReleased {
            escrow_id,
            submission_id,
            to,
            amount: rec.amount,
            verdict,
        }
        .publish(&e);
        Ok(())
    }
}

#[cfg(test)]
mod test;
