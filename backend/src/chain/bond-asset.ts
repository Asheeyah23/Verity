/** What comparing the gate's bond asset with the configured one came to. */
export type BondAssetCheck = { ok: true } | { ok: false; message: string };

/**
 * EscrowGate takes every bond and stake in one token, fixed when it is
 * deployed. `BOND_ASSET_CONTRACT_ID` has to name that token: it is what this
 * backend reports as the asset to approve, so a wrong value sends users to
 * the wrong token.
 */
export function checkBondAsset(
  onChain: string | null | undefined,
  configured: string,
  gateId: string,
): BondAssetCheck {
  if (!onChain) {
    return {
      ok: false,
      message: `EscrowGate ${gateId} reports no bond asset, so BOND_ASSET_CONTRACT_ID (${configured}) cannot be right for it. Check ESCROW_GATE_CONTRACT_ID.`,
    };
  }
  if (onChain !== configured) {
    return {
      ok: false,
      message:
        `BOND_ASSET_CONTRACT_ID is ${configured}, but EscrowGate ${gateId} takes its bonds in ${onChain}. ` +
        "Set BOND_ASSET_CONTRACT_ID to the gate's asset (bond_asset_sac_address in the deployment record), or point ESCROW_GATE_CONTRACT_ID at the gate you meant.",
    };
  }
  return { ok: true };
}

/**
 * Run once at startup, before the API listens. A gate whose asset differs
 * from the configured one stops the process with the two ids. A gate that
 * cannot be asked is not a disagreement: the RPC may be down, or the gate may
 * have been deployed before it had `get_bond_asset`. That is logged and the
 * backend starts, with the configured asset left unverified.
 */
export async function assertBondAssetMatchesGate(deps: {
  read: () => Promise<string | null | undefined>;
  configured: string;
  gateId: string;
  warn: (message: string) => void;
}): Promise<void> {
  let onChain: string | null | undefined;
  try {
    onChain = await deps.read();
  } catch (err) {
    deps.warn(
      `Could not read EscrowGate ${deps.gateId}'s bond asset, so BOND_ASSET_CONTRACT_ID (${deps.configured}) is not verified: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const check = checkBondAsset(onChain, deps.configured, deps.gateId);
  if (!check.ok) throw new Error(check.message);
}
