use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAdmin = 3,
    InvalidConfig = 4,
    Overflow = 5,
    InvalidAmount = 6,

    SubmissionNotFound = 10,
    BondTooLow = 11,
    InvalidTaskType = 12,
    InvalidEscrowValue = 13,
    InvalidOutputHash = 14,

    ReexecutorNotActive = 20,
    StakeBelowFloor = 21,
    StakeLockedByOpenAttestation = 22,
    AlreadyAttested = 23,
    ReexecutorAlreadyRegistered = 24,
    AttestationAlreadyReleased = 25,
    SubmissionNotFinalized = 26,
    ReexecutorNotApproved = 27,
    VoteContradictsHash = 28,
    AgentCannotAttest = 29,

    ChallengeAlreadyOpen = 30,
    ChallengeNotFound = 31,
    ChallengeWindowClosed = 32,
    ChallengeWindowNotElapsed = 33,
    NoUnresolvedChallenge = 34,
    ChallengeAlreadyResolved = 35,
    AgentCannotChallenge = 36,
    ConsensusAlreadyReached = 37,

    NotUpheldResolution = 40,
    AlreadySlashed = 41,
    PartyNotOnWrongSide = 42,
    InsufficientConsensus = 44,
    InvalidResolutionMethod = 45,
    NotSlashable = 46,

    VerifierNotRegistered = 50,
    VerifierAlreadyRegistered = 51,
    ProofRejected = 52,
}
