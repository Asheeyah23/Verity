#![no_std]

//! Reference contract only — demonstrates the drop-in wrapper pattern any real
//! marketplace's own escrow contract uses to gate its `release()` on Verity's
//! `EscrowGate.finalize()` before paying an agent. Not deployed as part of
//! Verity's own stack; shipped as integration documentation an external
//! integrator can copy the pattern from (Rust) or reimplement against the
//! exported EscrowGate contract spec (any language via stellar-sdk bindings).
//!
//! The contract is initialized atomically at deployment via `__constructor`,
//! fixing the Verity `EscrowGate` address so setup cannot be front-run. Each
//! escrow names the token it pays in.

mod events;

use events::{EscrowCreated, EscrowRefunded, EscrowReleased};
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env};
use verity_common::{Error, SubmissionRecord, Verdict};

/// The longest challenge window `EscrowGate` accepts (`MAX_WINDOW_S` in
/// contracts/escrow-gate/src/lib.rs): 7 days. Duplicated rather than shared,
/// because depending on the `escrow-gate` crate at runtime would link its
/// `#[contractimpl]` entrypoints into this contract's wasm and expose them as
/// this contract's own. EscrowGate is only ever reached here by address, via
/// `invoke_contract`; the crate is a dev-dependency for the tests alone.
const MAX_CHALLENGE_WINDOW_S: u64 = 7 * 24 * 60 * 60; // 604_800

/// Grace after an escrow's deadline before its poster may reclaim it. Covers
/// the longest legitimate in-flight lifetime of work started before the
/// deadline: a submission created just before it can still be inside its own
/// challenge window at the deadline, and a challenge opened as that window
/// closes can run for one further window before `release()` sees a terminal
/// verdict. Two maximum challenge windows bound that worst case.
const REFUND_GRACE_S: u64 = 2 * MAX_CHALLENGE_WINDOW_S;

#[contracttype]
#[derive(Clone)]
pub(crate) enum DataKey {
    Gate,
    Escrow(u64),
    NextId,
}

/// One escrow. Public so that `get_escrow` can return it: a payee reads the
/// token, the amount and the escrow value before taking the work.
#[contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EscrowRecord {
    pub payee: Address,
    pub poster: Address,
    /// The SEP-41 token the escrow is held and paid in.
    pub token: Address,
    /// How much of `token` is held, in that token's smallest unit.
    pub amount: i128,
    /// The `escrow_value` the payee's EscrowGate submission must declare, in
    /// the units of the gate's bond asset. The gate sizes the agent's bond, a
    /// challenger's bond and the challenge window from it.
    pub escrow_value: i128,
    /// A ledger timestamp after which the poster may reclaim the funds with
    /// `refund_expired()` if the payee never delivered.
    pub deadline: u64,
    pub released: bool,
}

// The thresholds EscrowGate uses (contracts/escrow-gate/src/storage.rs). An
// entry is extended whenever it is written, so a bounty that waits weeks for
// work does not have its record archived before release() needs it.
const BUMP_THRESHOLD: u32 = 100_000;
const BUMP_TO: u32 = 500_000;

/// Extends an escrow's record and the instance. The instance holds the gate
/// and the id counter, and its TTL also covers the contract code.
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
    /// setup by claiming a fake gate. The marketplace is told which EscrowGate it
    /// trusts, and nothing about tokens: each escrow names its own, and bonds are
    /// the gate's business.
    pub fn __constructor(e: Env, gate: Address) {
        e.storage().instance().set(&DataKey::Gate, &gate);
    }

    /// The bounty poster escrows `amount` of `token` for a specific payee
    /// agent, before any Verity submission exists. `token` is any SEP-41
    /// token, for example the Stellar Asset Contract of USDC. It does not
    /// have to be the asset EscrowGate takes bonds in.
    ///
    /// `escrow_value` is the link between the two. It is the value the
    /// payee's EscrowGate submission must declare for this escrow, in the
    /// units of the gate's bond asset, and the gate sizes the agent's bond, a
    /// challenger's bond and the challenge window from it. The poster
    /// chooses it. Nothing here converts `amount` into it, so the example
    /// needs no price oracle: a poster who escrows 250 USDC and wants the
    /// work bonded as 2,500 XLM of value passes both numbers.
    ///
    /// `deadline` is a ledger timestamp after which the payee has no promise
    /// of payment: the poster may reclaim the escrow with `refund_expired()`
    /// once the grace period after it has passed. It must be in the future.
    pub fn create_escrow(
        e: Env,
        poster: Address,
        payee: Address,
        token: Address,
        amount: i128,
        escrow_value: i128,
        deadline: u64,
    ) -> Result<u64, Error> {
        poster.require_auth();
        // A deadline already at or before now would let the poster refund the
        // escrow as soon as the grace period has run out, so it is refused
        // here before anything moves.
        if deadline <= e.ledger().timestamp() {
            return Err(Error::DeadlineInThePast);
        }
        // An escrow of nothing pays nobody, and a negative amount would only
        // fail later, inside the token transfer, with a host error. Both are
        // refused here, before anything moves.
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        // EscrowGate refuses a submission that declares no escrow value, so
        // an escrow that expects one could never be released.
        if escrow_value <= 0 {
            return Err(Error::InvalidEscrowValue);
        }
        soroban_sdk::token::TokenClient::new(&e, &token).transfer(
            &poster,
            e.current_contract_address(),
            &amount,
        );

        let id: u64 = e.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        e.storage().instance().set(&DataKey::NextId, &(id + 1));
        e.storage().persistent().set(
            &DataKey::Escrow(id),
            &EscrowRecord {
                payee: payee.clone(),
                poster: poster.clone(),
                token: token.clone(),
                amount,
                escrow_value,
                deadline,
                released: false,
            },
        );
        bump(&e, id);

        EscrowCreated {
            escrow_id: id,
            poster,
            payee,
            token,
            amount,
            escrow_value,
        }
        .publish(&e);
        Ok(id)
    }

    /// The one line a real marketplace adds to its own release() path:
    /// gate `finalize()` before paying out. Verdict::Verified pays the agent;
    /// Slashed/ExpiredUnverified returns funds to the bounty poster instead;
    /// Pending/Disputed simply refuse to release yet. Either way the money
    /// moves in the escrow's own token.
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
        // The submission must declare the value the poster asked for. The
        // escrowed amount is not compared with anything: it is in the
        // escrow's token, and the gate counts in its own bond asset.
        if submission.escrow_value != rec.escrow_value {
            return Err(Error::InvalidEscrowValue);
        }

        let verdict: Verdict = e.invoke_contract(
            &gate,
            &soroban_sdk::Symbol::new(&e, "finalize"),
            soroban_sdk::vec![&e, soroban_sdk::IntoVal::into_val(&submission_id, &e)],
        );

        let token = soroban_sdk::token::TokenClient::new(&e, &rec.token);
        let contract_address = e.current_contract_address();

        let to = match verdict {
            Verdict::Verified => rec.payee.clone(),
            Verdict::Slashed | Verdict::ExpiredUnverified => rec.poster.clone(),
            Verdict::Pending | Verdict::Disputed => {
                return Err(Error::ChallengeWindowNotElapsed);
            }
        };
        // If the token refuses the transfer (a classic asset does when the
        // receiving account has no trustline to it), the whole call fails:
        // nothing is paid, the escrow stays unreleased and the finalize()
        // above is undone with it. It can be released once the receiver can
        // be paid.
        token.transfer(&contract_address, to.clone(), &rec.amount);
        rec.released = true;
        e.storage().persistent().set(&DataKey::Escrow(escrow_id), &rec);
        bump(&e, escrow_id);

        EscrowReleased {
            escrow_id,
            submission_id,
            to,
            token: rec.token,
            amount: rec.amount,
            verdict,
        }
        .publish(&e);
        Ok(())
    }

    /// Reclaims an escrow the payee never delivered on. The poster must sign,
    /// and the funds can only leave once the deadline has passed and a grace
    /// period has run out. The grace period is the in-flight-work rule: a
    /// submission created before the deadline is never cut off while it can
    /// still be verified, because `REFUND_GRACE_S` covers its challenge window
    /// plus the one further window an unresolved challenge can last. Until
    /// then this returns `DeadlineNotElapsed` and the poster must wait.
    ///
    /// `release()` keeps working after the deadline, so work that does settle
    /// is still paid even if the poster has not asked for a refund. A refund
    /// is final: once it happens, `release()` is a no-op.
    pub fn refund_expired(e: Env, escrow_id: u64) -> Result<(), Error> {
        let mut rec: EscrowRecord = e
            .storage()
            .persistent()
            .get(&DataKey::Escrow(escrow_id))
            .ok_or(Error::SubmissionNotFound)?;
        rec.poster.require_auth();
        if rec.released {
            return Err(Error::AlreadyReleased);
        }
        if e.ledger().timestamp() < rec.deadline.saturating_add(REFUND_GRACE_S) {
            return Err(Error::DeadlineNotElapsed);
        }

        let token = soroban_sdk::token::TokenClient::new(&e, &rec.token);
        token.transfer(&e.current_contract_address(), rec.poster.clone(), &rec.amount);

        rec.released = true;
        e.storage().persistent().set(&DataKey::Escrow(escrow_id), &rec);
        bump(&e, escrow_id);
        EscrowRefunded {
            escrow_id,
            poster: rec.poster.clone(),
            token: rec.token.clone(),
            amount: rec.amount,
        }
        .publish(&e);
        Ok(())
    }

    /// The escrow as recorded, or nothing for an id that was never created.
    /// The payee reads it before taking the work: the token it will be paid
    /// in, how much, and the `escrow_value` its EscrowGate submission has to
    /// declare.
    pub fn get_escrow(e: Env, escrow_id: u64) -> Option<EscrowRecord> {
        e.storage().persistent().get(&DataKey::Escrow(escrow_id))
    }
}

#[cfg(test)]
mod test;
