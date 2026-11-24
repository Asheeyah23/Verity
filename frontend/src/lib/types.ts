export type TaskType = "deterministic" | "retrieval" | "unverifiable";
export type SubmissionStatus =
  | "pending"
  | "verified"
  | "disputed"
  | "slashed"
  | "expired_unverified";

export interface Submission {
  id: string;
  escrow_ref: string;
  marketplace_id: string;
  agent_id: string;
  task_type: TaskType;
  input_hash: string;
  input_ref: string | null;
  function_hash: string | null;
  function_ref: string | null;
  claimed_output_hash: string;
  claimed_output_ref: string | null;
  bond_amount: string;
  bond_asset: string;
  submitted_at: string;
  challenge_window_s: number;
  status: SubmissionStatus;
  chain_submission_id: string | null;
  chain_tx_hash: string | null;
  idempotency_key: string | null;
  finalize_attempted_at: string | null;
  settled_at: string | null;
  /** How the terminal verdict was reached, read from the contract. Null until finalized. */
  resolution_method: SubmissionResolutionMethod | null;
  finalize_tx_hash: string | null;
  escrow_value: string | null;
  /** Smallest challenger bond the contract accepts for this submission, in stroops. */
  min_challenger_bond: string | null;
  created_at: string;
  updated_at: string;
}

/** `window_elapsed`: the challenge window closed without a bonded consensus,
 * so the work was never replayed to quorum. */
export type SubmissionResolutionMethod = "reexecution_consensus" | "window_elapsed" | "zk_proof";

export type ReplayStatus = "assigned" | "submitted" | "confirmed_onchain" | "missed";

export interface Replay {
  id: string;
  submission_id: string;
  reexecutor_id: string;
  status: ReplayStatus;
  assignment_seed: string | null;
  replay_output_hash: string | null;
  match: boolean | null;
  tx_hash: string | null;
  slash_tx_hash: string | null;
  assigned_at: string;
  executed_at: string | null;
  reexecutor_account: string;
}

export type SpotCheckResult = "match" | "mismatch" | "inconclusive";

export interface SpotCheck {
  id: string;
  submission_id: string;
  reexecutor_id: string;
  sampled_at: string;
  result: SpotCheckResult | null;
  evidence: unknown;
  reexecutor_account: string;
}

/** `expired`: no quorum resolved the challenge in time; both bonds went back. */
export type ChallengeResolution = "upheld" | "rejected" | "expired";
export type ChallengeResolutionMethod =
  | "reexecution_consensus"
  | "zk_proof"
  | "manual_review";

export interface Challenge {
  id: string;
  submission_id: string;
  challenger_account: string;
  challenger_bond: string;
  opened_at: string;
  resolved_at: string | null;
  resolution: ChallengeResolution | null;
  resolution_method: ChallengeResolutionMethod | null;
  chain_tx_hash: string | null;
}

export interface ChallengeListItem extends Challenge {
  escrow_ref: string;
  task_type: TaskType;
  status: SubmissionStatus;
  chain_submission_id: string | null;
}

/** A re-executor's record, counted from its assignments and each
 * submission's on-chain outcome. */
export interface ReexecutorStats {
  attested: number;
  /** Votes on the side a bonded consensus settled on. */
  agreed: number;
  /** Votes a bonded consensus proved wrong. */
  disagreed: number;
  /** Assignments the submission was finalized without. */
  missed: number;
}

export interface Reexecutor {
  id: string;
  stellar_account: string;
  stake_amount: string;
  stake_asset: string;
  /** Stake is at or above the contract's floor. */
  active: boolean;
  /** Approved by the deployment admin as a voter. */
  approved: boolean;
  /** Active, and approved if this deployment runs an allow-list. */
  can_vote: boolean;
  /** A worker for this account polled for work within the liveness window. */
  online: boolean;
  slashed_count: number;
  chain_stake_tx_hash: string | null;
  last_seen_at: string | null;
  joined_at: string;
  stats: ReexecutorStats;
}

export interface SlashingEvent {
  id: string;
  reexecutor_id: string;
  submission_id: string | null;
  chain_submission_id: string | null;
  amount: string;
  reason: string;
  tx_hash: string | null;
  created_at: string;
}

export interface SubmissionDetail {
  submission: Submission;
  replays: Replay[];
  spot_checks: SpotCheck[];
  challenge: Challenge | null;
  has_attestation: boolean;
}

/** The rules this deployment's EscrowGate enforces, read from the contract.
 * Amounts are stroops. */
export interface GateConfig {
  deployment: string;
  network_passphrase: string;
  escrow_gate_contract_id: string;
  min_stake_floor: string;
  quorum_min_reexecutors: number;
  quorum_supermajority_bps: number;
  agent_bond_min_bps: number;
  challenger_bond_min_bps: number;
  window_tier_small_ceiling: string;
  window_tier_small_s: number;
  window_tier_large_s: number;
  slash_split_challenger_bps: number;
  reexecutor_slash_bps: number;
  reexecutor_allowlist: boolean;
  reexecutor_liveness_s: number;
}

export interface Attestation {
  payload: Record<string, unknown>;
  canonical: string;
  signature: string;
  signature_algorithm: string;
  signer: string | null;
  delivered_to: string | null;
  issued_at: string;
}

export interface Artifact {
  content_hash: string;
  content_base64: string;
}

export interface ProofStatus {
  available: boolean;
  phase?: number;
  reason?: string;
}

export interface TaxonomyEntry {
  type: TaskType;
  verification_method: string;
  description: string;
}

export interface Taxonomy {
  version: number;
  task_types: TaxonomyEntry[];
}

export interface VerificationRatesReport {
  by_marketplace_task_status: Array<{
    marketplace_id: string;
    marketplace_name: string;
    marketplace_account: string;
    task_type: TaskType;
    status: SubmissionStatus;
    count: string;
  }>;
  slashing_events_total: number;
  false_accept_rate: number | null;
}
