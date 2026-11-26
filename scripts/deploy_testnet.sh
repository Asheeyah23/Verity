#!/usr/bin/env bash
# Deploys a fresh EscrowGate and ZKVerifierRegistry to Stellar testnet and
# records them in deployments/<name>.json. Each contract is deployed and
# configured in one transaction (constructor args), so there is never a
# deployed-but-unclaimed contract somebody else could initialise.
#
# This always creates NEW contracts — EscrowGate has no upgrade entrypoint —
# so it refuses to replace an existing deployment record unless --force is
# given. After a redeploy the re-executors must be staked and approved again
# (scripts/bootstrap_reexecutors.sh) and the database reset.
#
#   VERITY_DEPLOYMENT   deployment name (default: testnet, the dev deployment)
#   VERITY_NETWORK      testnet (default) or mainnet (requires the mainnet flag)
#   VERITY_RPC_URL      Soroban RPC URL recorded in deployments/<name>.json
#   --public            mark the deployment as one real users are on; the dev
#                       runner and smoke test will refuse to touch it
#   --force             replace an existing deployments/<name>.json
#   --replace-public    required in addition to --force when replacing a deployment
#                       record marked "public": true
#   --mainnet-i-have-read-docs-MAINNET
#                       required alongside VERITY_NETWORK=mainnet
#   VERITY_GATE_CONFIG  full EscrowGate ConfigRecord JSON, to override defaults
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
# shellcheck source=scripts/_deployment.sh
source "$ROOT_DIR/scripts/_deployment.sh"

PUBLIC=false
FORCE=0
REPLACE_PUBLIC=0
MAINNET_ACK=0
for arg in "$@"; do
  case "$arg" in
    --public) PUBLIC=true ;;
    --force) FORCE=1 ;;
    --replace-public) REPLACE_PUBLIC=1 ;;
    --mainnet-i-have-read-docs-MAINNET) MAINNET_ACK=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

NETWORK="${VERITY_NETWORK:-testnet}"
case "$NETWORK" in
  testnet)
    if [ "$MAINNET_ACK" = 1 ]; then
      echo "FATAL: --mainnet-i-have-read-docs-MAINNET requires VERITY_NETWORK=mainnet." >&2
      exit 2
    fi
    NETWORK_PASSPHRASE="$TESTNET_PASSPHRASE"
    SOROBAN_RPC_URL="${VERITY_RPC_URL:-${_CALLER_SOROBAN_RPC_URL:-$TESTNET_RPC_URL}}"
    ;;
  mainnet)
    if [ "$MAINNET_ACK" != 1 ]; then
      echo "FATAL: VERITY_NETWORK=mainnet requires --mainnet-i-have-read-docs-MAINNET." >&2
      echo "       Verity is not ready for mainnet; read docs/MAINNET.md first." >&2
      exit 1
    fi
    NETWORK_PASSPHRASE="$MAINNET_PASSPHRASE"
    SOROBAN_RPC_URL="${VERITY_RPC_URL:-${_CALLER_SOROBAN_RPC_URL:-$SOROBAN_RPC_URL}}"
    ;;
  *)
    echo "FATAL: VERITY_NETWORK must be 'testnet' or 'mainnet' (got '$NETWORK')." >&2
    exit 2
    ;;
esac

if [ -f "$DEPLOY_JSON" ] && [ "$FORCE" != 1 ]; then
  echo "FATAL: $DEPLOY_JSON already exists." >&2
  echo "       Deploying again creates new contracts and orphans every stake and" >&2
  echo "       submission on the current ones. Re-run with --force if that is intended." >&2
  exit 1
fi

if [ -f "$DEPLOY_JSON" ] && deployment_is_public && [ "$REPLACE_PUBLIC" != 1 ]; then
  echo "FATAL: $DEPLOY_JSON is marked public." >&2
  echo "       Replacing it creates new contracts and abandons all existing stakes and" >&2
  echo "       submissions on the public contracts. Re-run with --force --replace-public" >&2
  echo "       if you genuinely intend to replace the public deployment." >&2
  exit 1
fi

# Windows are the on-chain minimum (10 minutes) on a dev deployment so the
# window-elapsed paths can be exercised in one sitting; a public deployment
# gets the real 1h / 24h tiers. Everything else is the v1 default: quorum of
# 3, 66% bonded supermajority, 5% agent and challenger bonds, small tier under
# 100,000 XLM of escrow value, 20% of a slash to a prevailing challenger, 10%
# of stake forfeited by a wrong-side re-executor, and an admin-approved voter
# set (stake is free on testnet, so an open one could be captured for nothing).
if [ "$PUBLIC" = true ]; then
  WINDOW_SMALL_S=3600
  WINDOW_LARGE_S=86400
else
  WINDOW_SMALL_S=600
  WINDOW_LARGE_S=600
fi
GATE_CONFIG="${VERITY_GATE_CONFIG:-}"
if [ -z "$GATE_CONFIG" ]; then
  GATE_CONFIG='{"min_stake_floor":"5000000000","quorum_min_reexecutors":3,"quorum_supermajority_bps":6600,"agent_bond_min_bps":500,"challenger_bond_min_bps":500,"window_tier_small_ceiling":"1000000000000","window_tier_small_s":'"$WINDOW_SMALL_S"',"window_tier_large_s":'"$WINDOW_LARGE_S"',"slash_split_challenger_bps":2000,"reexecutor_slash_bps":1000,"reexecutor_allowlist":true}'
fi

# The dev deployment also needs a challenger for the smoke test.
IDENTITIES=("$DEPLOYER" "$KEEPER" "${BOOTSTRAP_REEXECUTORS[@]}")
if [ "$DEPLOYMENT" = testnet ]; then
  IDENTITIES+=(challenger1)
fi

account_is_funded() {
  local addr="$1" response
  [ -n "$SOROBAN_RPC_URL" ] || return 1
  response="$(curl -fsS --connect-timeout 5 --max-time 15 \
    -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccount\",\"params\":{\"address\":\"$addr\"}}" \
    "$SOROBAN_RPC_URL" 2>/dev/null || true)"
  echo "$response" | grep -q '"result"[[:space:]]*:'
}

echo "==> Deployment '$DEPLOYMENT' (network: $NETWORK, public: $PUBLIC)"
echo "==> Ensuring identities exist and are funded"
if [ "$NETWORK" = mainnet ]; then
  unfunded=()
  for name in "${IDENTITIES[@]}"; do
    if ! addr="$(stellar keys address "$name" 2>/dev/null)" || [ -z "$addr" ]; then
      unfunded+=("$name (missing from keystore)")
    elif ! account_is_funded "$addr"; then
      unfunded+=("$name ($addr)")
    fi
  done
  if [ "${#unfunded[@]}" -gt 0 ]; then
    echo "FATAL: mainnet identities must already exist and be funded; Friendbot (--fund) is never used on mainnet." >&2
    echo "       Missing or unfunded identities: ${unfunded[*]}" >&2
    exit 1
  fi
  if [ -z "$SOROBAN_RPC_URL" ]; then
    echo "FATAL: mainnet deployment requires VERITY_RPC_URL (or SOROBAN_RPC_URL) to be set." >&2
    exit 1
  fi
else
  for name in "${IDENTITIES[@]}"; do
    if ! stellar keys address "$name" >/dev/null 2>&1; then
      stellar keys generate "$name" --network "$NETWORK" --fund
    else
      stellar keys fund "$name" --network "$NETWORK" || true
    fi
  done
fi

DEPLOYER_ADDR=$(stellar keys address "$DEPLOYER")
echo "==> Deployer / admin: $DEPLOYER_ADDR"

echo "==> Resolving native XLM Stellar Asset Contract address"
NATIVE_SAC=$(stellar contract id asset --asset native --network "$NETWORK")
echo "==> Native XLM SAC: $NATIVE_SAC"

# The token EscrowGate takes every bond and stake in, fixed for the life of the
# contract. Native XLM unless VERITY_BOND_ASSET names another asset as
# CODE:ISSUER (testnet USDC, say). The amounts in the gate's config
# (min_stake_floor, window_tier_small_ceiling) are in that asset's smallest unit.
BOND_ASSET="${VERITY_BOND_ASSET:-native}"
if [ "$BOND_ASSET" = native ]; then
  BOND_ASSET_SAC="$NATIVE_SAC"
else
  echo "==> Resolving the Stellar Asset Contract address of $BOND_ASSET"
  BOND_ASSET_SAC=$(stellar contract id asset --asset "$BOND_ASSET" --network "$NETWORK")
  echo "NOTE: bonds and stakes on this deployment are in $BOND_ASSET, not XLM."
  echo "      Its asset contract must already exist on the network (stellar contract asset deploy),"
  echo "      and every re-executor, agent and challenger needs a trustline to it and a balance"
  echo "      before it can stake or post a bond. scripts/bootstrap_reexecutors.sh does not set those up."
fi
echo "==> Bond asset: $BOND_ASSET ($BOND_ASSET_SAC)"

echo "==> Building contracts (release profile)"
cd "$CONTRACTS_DIR"
stellar contract build

WASM_DIR="$CONTRACTS_DIR/target/wasm32v1-none/release"
GATE_WASM="$WASM_DIR/escrow_gate.wasm"
REGISTRY_WASM="$WASM_DIR/zk_verifier_registry.wasm"

RECOVERY_FILE="$(mktemp "${TMPDIR:-/tmp}/verity-$DEPLOYMENT-deploy.XXXXXX")"
cleanup_recovery() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ] && [ -s "$RECOVERY_FILE" ]; then
    echo "======================================================================" >&2
    echo "FATAL: Deployment failed after deploying one or more contracts!" >&2
    echo "Contract IDs saved to recovery file: $RECOVERY_FILE" >&2
    echo "Contents:" >&2
    cat "$RECOVERY_FILE" >&2
    echo "======================================================================" >&2
  elif [ "$exit_code" -eq 0 ]; then
    rm -f "$RECOVERY_FILE"
  fi
}
trap cleanup_recovery EXIT

echo "==> Deploying EscrowGate"
GATE_ID=$(stellar contract deploy \
  --wasm "$GATE_WASM" \
  --source "$DEPLOYER" \
  --network "$NETWORK" \
  -- \
  --admin "$DEPLOYER_ADDR" \
  --bond_asset "$BOND_ASSET_SAC" \
  --config "$GATE_CONFIG")
echo "EscrowGate contract id: $GATE_ID"
echo "escrow_gate_contract_id=$GATE_ID" >> "$RECOVERY_FILE"

# EscrowGate does not consult the registry in Phase 1 (resolve_challenge
# rejects ZkProof); it is deployed as the anchor Phase 2 verifiers register in.
echo "==> Deploying ZKVerifierRegistry"
REGISTRY_ID=$(stellar contract deploy \
  --wasm "$REGISTRY_WASM" \
  --source "$DEPLOYER" \
  --network "$NETWORK" \
  -- \
  --admin "$DEPLOYER_ADDR")
echo "ZKVerifierRegistry contract id: $REGISTRY_ID"
echo "zk_verifier_registry_contract_id=$REGISTRY_ID" >> "$RECOVERY_FILE"

echo "==> Asserting ZKVerifierRegistry is genuinely empty (Phase 1 requirement)"
LIST_OUT=$(stellar contract invoke \
  --id "$REGISTRY_ID" --source "$DEPLOYER" --network "$NETWORK" \
  -- list_verifiers)
if [ "$LIST_OUT" != "[]" ]; then
  echo "FATAL: ZKVerifierRegistry is not empty after deploy: $LIST_OUT" >&2
  exit 1
fi
echo "==> Confirmed empty: $LIST_OUT"

echo "==> Writing $DEPLOY_JSON"
BOOTSTRAP_JSON="["
for name in "${BOOTSTRAP_REEXECUTORS[@]}"; do
  addr=$(stellar keys address "$name")
  BOOTSTRAP_JSON="$BOOTSTRAP_JSON{\"alias\":\"$name\",\"public_key\":\"$addr\"},"
done
BOOTSTRAP_JSON="${BOOTSTRAP_JSON%,}]"

CHALLENGER_JSON=""
if [ "$DEPLOYMENT" = testnet ]; then
  CHALLENGER_ADDR=$(stellar keys address challenger1)
  CHALLENGER_JSON="  \"challenger_public_key\": \"$CHALLENGER_ADDR\","$'\n'
fi

KEEPER_ADDR=$(stellar keys address "$KEEPER")

cat > "$DEPLOY_JSON.tmp" <<EOF
{
  "deployment": "$DEPLOYMENT",
  "public": $PUBLIC,
  "network": "$NETWORK",
  "network_passphrase": "$NETWORK_PASSPHRASE",
  "rpc_url": "$SOROBAN_RPC_URL",
  "escrow_gate_contract_id": "$GATE_ID",
  "zk_verifier_registry_contract_id": "$REGISTRY_ID",
  "bond_asset": "$BOND_ASSET",
  "bond_asset_sac_address": "$BOND_ASSET_SAC",
  "native_xlm_sac_address": "$NATIVE_SAC",
  "deployer_public_key": "$DEPLOYER_ADDR",
  "keeper_public_key": "$KEEPER_ADDR",
${CHALLENGER_JSON}  "bootstrap_reexecutors": $BOOTSTRAP_JSON,
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
mv "$DEPLOY_JSON.tmp" "$DEPLOY_JSON"
echo "==> Wrote $DEPLOY_JSON"
echo ""
echo "Secret keys for all generated identities live in ~/.config/stellar/identity/*.toml"
echo "(never committed; deployments/*.json only ever holds public keys/contract IDs)."
echo ""
echo "Next:"
echo "  scripts/bootstrap_reexecutors.sh   # stake and approve the re-executor fleet"
echo "  scripts/generate_bindings.sh       # only if the contract interface changed"
echo "  pnpm db:reset                      # a new contract restarts submission ids at 0;"
echo "                                     # a database still holding the old contract's rows is wrong"
echo "Done."
