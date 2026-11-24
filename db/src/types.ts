import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** Generated<ColumnType<...>> double-wraps and breaks Kysely's
 * Insertable/Updateable inference (it only unwraps one ColumnType layer), so
 * defaulted timestamp columns use this single-layer form directly instead
 * of `GeneratedTimestamp`. */
type GeneratedTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface MarketplaceTable {
  id: Generated<string>;
  stellar_account: string;
  name: string;
  webhook_secret: string | null;
  created_at: GeneratedTimestamp;
}

export type TaskType = "deterministic" | "retrieval" | "unverifiable";
export type SubmissionStatus =
  | "pending"
  | "verified"
  | "disputed"
  | "slashed"
  | "expired_unverified";

/** How a terminal verdict was reached, mirrored from the chain record.
 * `window_elapsed` means the window closed without a bonded consensus — the
 * work was never replayed to quorum. */
export type SubmissionResolutionMethod = "reexecution_consensus" | "window_elapsed" | "zk_proof";

export interface SubmissionTable {
  id: Generated<string>;
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
  submitted_at: GeneratedTimestamp;
  challenge_window_s: number;
  status: Generated<SubmissionStatus>;
  chain_submission_id: string | null;
  chain_tx_hash: string | null;
  idempotency_key: string | null;
  finalize_attempted_at: Timestamp | null;
  settled_at: Timestamp | null;
  resolution_method: SubmissionResolutionMethod | null;
  finalize_tx_hash: string | null;
  escrow_value: string | null;
  min_challenger_bond: string | null;
  /** Last time the relay endpoint broadcast this draft's signed transaction. */
  relay_started_at: Timestamp | null;
  created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ReexecutorTable {
  id: Generated<string>;
  stellar_account: string;
  stake_amount: string;
  stake_asset: string;
  reputation_score: Generated<string>;
  active: Generated<boolean>;
  approved: Generated<boolean>;
  slashed_count: Generated<number>;
  chain_stake_tx_hash: string | null;
  last_seen_at: Timestamp | null;
  joined_at: GeneratedTimestamp;
}

export type ReplayStatus = "assigned" | "submitted" | "confirmed_onchain" | "missed";

export interface ReplayTable {
  id: Generated<string>;
  submission_id: string;
  reexecutor_id: string;
  status: Generated<ReplayStatus>;
  assignment_seed: string | null;
  replay_output_hash: string | null;
  match: boolean | null;
  latency_ms: number | null;
  cost: string | null;
  tx_hash: string | null;
  slash_tx_hash: string | null;
  lock_released_at: Timestamp | null;
  assigned_at: GeneratedTimestamp;
  executed_at: Timestamp | null;
}

export type SpotCheckResult = "match" | "mismatch" | "inconclusive";

export interface SpotCheckTable {
  id: Generated<string>;
  submission_id: string;
  reexecutor_id: string;
  sampled_at: GeneratedTimestamp;
  result: SpotCheckResult | null;
  evidence: unknown | null;
}

/** `expired`: no quorum resolved the challenge in time; both bonds went back. */
export type ChallengeResolution = "upheld" | "rejected" | "expired";
export type ChallengeResolutionMethod =
  | "reexecution_consensus"
  | "zk_proof"
  | "manual_review";

export interface ChallengeTable {
  id: Generated<string>;
  submission_id: string;
  challenger_account: string;
  challenger_bond: string;
  opened_at: GeneratedTimestamp;
  resolved_at: Timestamp | null;
  resolution: ChallengeResolution | null;
  resolution_method: ChallengeResolutionMethod | null;
  chain_tx_hash: string | null;
}

export interface ZkProofTable {
  id: Generated<string>;
  submission_id: string;
  proof_system: string | null;
  verifier_contract: string | null;
  proof_blob_ref: string | null;
  verified_onchain: boolean | null;
  tx_hash: string | null;
  cost: string | null;
  proving_time_ms: number | null;
  created_at: GeneratedTimestamp;
}

export interface AttestationExportTable {
  id: Generated<string>;
  submission_id: string;
  target_registry: Generated<string>;
  payload: unknown;
  signature: string;
  exported_at: GeneratedTimestamp;
}

export interface SlashingEventTable {
  id: Generated<string>;
  reexecutor_id: string;
  submission_id: string | null;
  amount: string;
  reason: string;
  tx_hash: string | null;
  created_at: GeneratedTimestamp;
}

export type ArtifactKind = "input" | "function" | "output" | "request_spec";

export interface SubmissionArtifactTable {
  id: Generated<string>;
  submission_id: string;
  kind: ArtifactKind;
  content_hash: string;
  storage_ref: string;
  content_type: string | null;
  size_bytes: number | null;
  created_at: GeneratedTimestamp;
}

export interface WebhookSubscriptionTable {
  id: Generated<string>;
  marketplace_id: string;
  url: string;
  secret: string;
  events: string[];
  active: Generated<boolean>;
  created_at: GeneratedTimestamp;
}

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

export interface WebhookDeliveryTable {
  id: Generated<string>;
  subscription_id: string;
  event_type: string;
  payload: unknown;
  status: Generated<WebhookDeliveryStatus>;
  attempts: Generated<number>;
  last_attempt_at: Timestamp | null;
  response_code: number | null;
  created_at: GeneratedTimestamp;
}

export interface ChainCursorTable {
  contract_id: string;
  last_ledger: ColumnType<string, string | number, string | number>;
  last_paging_token: string | null;
  updated_at: GeneratedTimestamp;
}

export interface Database {
  marketplace: MarketplaceTable;
  submission: SubmissionTable;
  reexecutor: ReexecutorTable;
  replay: ReplayTable;
  spot_check: SpotCheckTable;
  challenge: ChallengeTable;
  zk_proof: ZkProofTable;
  attestation_export: AttestationExportTable;
  slashing_event: SlashingEventTable;
  submission_artifact: SubmissionArtifactTable;
  webhook_subscription: WebhookSubscriptionTable;
  webhook_delivery: WebhookDeliveryTable;
  chain_cursor: ChainCursorTable;
}
