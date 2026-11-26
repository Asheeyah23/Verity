#!/usr/bin/env bash
# Runs the end-to-end smoke test against a stack started by `pnpm dev`.
# Plays the agent and the challenger with two funded testnet identities from
# your stellar-cli keystore; the re-executor agents started by `pnpm dev` do
# the actual replaying and on-chain attesting.
#
# Smoke submissions are real on-chain records, so this only ever runs against
# a local backend on a deployment that is not marked public.
#
#   SMOKE_AGENT_ALIAS (agent1)  SMOKE_CHALLENGER_ALIAS (challenger1)
#   VERITY_API_PORT (3001)      SMOKE_ONLY=honest-deterministic,...
#   VERITY_DEPLOYMENT (testnet)
#   SMOKE_PROFILE=quorum        default: needs a quorum of re-executors online
#   SMOKE_PROFILE=underquorum   needs fewer than a quorum online
#                               (VERITY_REEXECUTORS="rex1 rex2" pnpm dev);
#                               waits out real challenge windows
#   SMOKE_SLOW=1                quorum profile: also wait out one window
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/_deployment.sh
source "$ROOT_DIR/scripts/_deployment.sh"
require_commands stellar curl node
require_deployment
refuse_public_deployment "The smoke test writes real test submissions on-chain and must never run against it."
refuse_mainnet_deployment "The smoke test writes real test submissions on-chain and must never run against mainnet."
assert_identities_match

API_PORT="${VERITY_API_PORT:-3001}"
AGENT_ALIAS="${SMOKE_AGENT_ALIAS:-agent1}"
CHALLENGER_ALIAS="${SMOKE_CHALLENGER_ALIAS:-challenger1}"

PROFILE="${SMOKE_PROFILE:-quorum}"
GATE_ID="$(json_field escrow_gate_contract_id)"

for alias in "$AGENT_ALIAS" "$CHALLENGER_ALIAS"; do
  if ! stellar keys address "$alias" >/dev/null 2>&1; then
    echo "==> Creating and funding testnet identity '$alias'"
    stellar keys generate "$alias" --network "$NETWORK" --fund
  fi
done

if ! curl -fs --connect-timeout 2 --max-time 5 "http://127.0.0.1:$API_PORT/health/live" >/dev/null; then
  echo "FATAL: no Verity backend on :$API_PORT — start the stack with 'pnpm dev' first" >&2
  exit 1
fi

# The quorum profile includes a scenario where a re-executor casts a wrong
# vote and is slashed for it. That takes a real staked, approved account that
# is not part of the fleet: no worker runs for it, the smoke test signs its
# one deliberately wrong vote itself.
ROGUE_SECRET=""
if [ "$PROFILE" = quorum ]; then
  ROGUE_ALIAS="${SMOKE_ROGUE_ALIAS:-${ALIAS_PREFIX}smoke-rogue}"
  if ! stellar keys address "$ROGUE_ALIAS" >/dev/null 2>&1; then
    echo "==> Creating and funding testnet identity '$ROGUE_ALIAS'"
    stellar keys generate "$ROGUE_ALIAS" --network "$NETWORK" --fund
  fi
  ROGUE_ADDR="$(stellar keys address "$ROGUE_ALIAS")"
  # A failed read must not look like "not staked": staking again adds another 1,000 XLM.
  if ! ROGUE_INFO="$(stellar contract invoke --id "$GATE_ID" --source "$ROGUE_ALIAS" --network "$NETWORK" \
    -- reexecutor_info --reexecutor "$ROGUE_ADDR" 2>/dev/null)"; then
    echo "FATAL: could not read '$ROGUE_ALIAS' state from the RPC; not staking. Re-run once the RPC answers." >&2
    exit 1
  fi
  if ! echo "$ROGUE_INFO" | grep -q '"active": *true'; then
    echo "==> Staking '$ROGUE_ALIAS' (1,000 XLM)"
    stellar keys fund "$ROGUE_ALIAS" --network "$NETWORK" >/dev/null 2>&1 || true
    stellar contract invoke --id "$GATE_ID" --source "$ROGUE_ALIAS" --network "$NETWORK" \
      -- register_reexecutor --reexecutor "$ROGUE_ADDR" --stake_amount 10000000000
  fi
  if ! echo "$ROGUE_INFO" | grep -q '"approved": *true'; then
    echo "==> Approving '$ROGUE_ALIAS' as a voter"
    stellar contract invoke --id "$GATE_ID" --source "$DEPLOYER" --network "$NETWORK" \
      -- set_reexecutor_approved --admin "$(stellar keys address "$DEPLOYER")" --reexecutor "$ROGUE_ADDR" --approved
  fi
  ROGUE_SECRET="$(stellar keys secret "$ROGUE_ALIAS")"
fi

cd "$ROOT_DIR/backend"
SMOKE_AGENT_SECRET="$(stellar keys secret "$AGENT_ALIAS")" \
SMOKE_CHALLENGER_SECRET="$(stellar keys secret "$CHALLENGER_ALIAS")" \
SMOKE_ROGUE_SECRET="$ROGUE_SECRET" \
SMOKE_BACKEND_URL="http://127.0.0.1:$API_PORT" \
SMOKE_EXPECT_CONTRACT_ID="$GATE_ID" \
SMOKE_PROFILE="$PROFILE" \
SOROBAN_RPC_URL="$SOROBAN_RPC_URL" \
  exec node_modules/.bin/tsx src/smoke/run.ts
