//! What the reference marketplace publishes, so an off-chain UI can list
//! escrows and see payouts without polling contract storage.

use soroban_sdk::{contractevent, Address};
use verity_common::Verdict;

#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EscrowCreated {
    #[topic]
    pub escrow_id: u64,
    pub poster: Address,
    pub payee: Address,
    pub amount: i128,
}

/// The escrow paid out. `to` is the payee after a `Verified` verdict and the
/// poster after `Slashed` or `ExpiredUnverified`; `verdict` says which.
#[contractevent]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EscrowReleased {
    #[topic]
    pub escrow_id: u64,
    pub submission_id: u64,
    pub to: Address,
    pub amount: i128,
    pub verdict: Verdict,
}
