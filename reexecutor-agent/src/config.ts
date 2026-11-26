export interface LocalConfig {
  contractId: string;
  networkPassphrase: string;
}

export interface BackendConfig {
  escrow_gate_contract_id?: unknown;
  network_passphrase?: unknown;
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

/**
 * Compares this worker's EscrowGate contract ID and Stellar network passphrase
 * against what the backend advertises at `GET /v1/config`.
 *
 * Returns one human-readable message per differing field (naming both values),
 * or an empty array when the worker and backend agree.
 */
export function findConfigMismatches(local: LocalConfig, remote: BackendConfig): string[] {
  const mismatches: string[] = [];
  if (remote.escrow_gate_contract_id !== local.contractId) {
    mismatches.push(
      `ESCROW_GATE_CONTRACT_ID mismatch: worker=${local.contractId} backend=${formatValue(remote.escrow_gate_contract_id)}`
    );
  }
  if (remote.network_passphrase !== local.networkPassphrase) {
    mismatches.push(
      `NETWORK_PASSPHRASE mismatch: worker="${local.networkPassphrase}" backend="${formatValue(remote.network_passphrase)}"`
    );
  }
  return mismatches;
}
