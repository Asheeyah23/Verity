import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { getGateConfig } from "../../chain/config.js";

/** The rules this deployment's EscrowGate enforces, read from the contract.
 * The dashboard uses them to say what a bond or stake must be before it
 * asks a wallet to sign anything. Amounts are stroops, as strings. */
export async function configRoutes(app: FastifyInstance) {
  app.get("/v1/config", async () => {
    const cfg = await getGateConfig();
    return {
      deployment: env.DEPLOYMENT_NAME,
      network_passphrase: env.NETWORK_PASSPHRASE,
      escrow_gate_contract_id: env.ESCROW_GATE_CONTRACT_ID,
      public_api_url: `${env.PUBLIC_SCHEME}://${env.WEB_AUTH_DOMAIN}`,
      // What the dashboard formats amounts with. It reads "native" or an object
      // with a symbol and decimals, which this backend does not know for another
      // token, so the value is left as it was.
      bond_asset: "native",
      // The contract id of the token bonds and stakes are paid in: checked
      // against the gate's own at startup (chain/bond-asset.ts).
      bond_asset_contract_id: env.BOND_ASSET_CONTRACT_ID,
      min_stake_floor: cfg.min_stake_floor.toString(),
      quorum_min_reexecutors: cfg.quorum_min_reexecutors,
      quorum_supermajority_bps: cfg.quorum_supermajority_bps,
      agent_bond_min_bps: cfg.agent_bond_min_bps,
      challenger_bond_min_bps: cfg.challenger_bond_min_bps,
      window_tier_small_ceiling: cfg.window_tier_small_ceiling.toString(),
      window_tier_small_s: Number(cfg.window_tier_small_s),
      window_tier_large_s: Number(cfg.window_tier_large_s),
      slash_split_challenger_bps: cfg.slash_split_challenger_bps,
      reexecutor_slash_bps: cfg.reexecutor_slash_bps,
      reexecutor_allowlist: cfg.reexecutor_allowlist,
      reexecutor_liveness_s: env.REEXECUTOR_LIVENESS_S,
      artifact_max_bytes: env.ARTIFACT_MAX_BYTES,
    };
  });
}
