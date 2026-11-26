#!/usr/bin/env bash
# Runs the whole Verity stack locally against the real, already-deployed
# Stellar testnet contracts — no Docker needed:
#
#   Postgres (embedded) -> migrations -> backend (API + indexer + keeper)
#   -> one reexecutor-agent per bootstrap identity -> frontend
#
# Secrets are read from your stellar-cli identities at start-up and handed to
# each process through its environment; this script never writes a secret key
# to disk except the session JWT secret in backend/.env (gitignored), and only
# when that file does not exist yet.
#
#   VERITY_API_PORT (3001)  VERITY_WEB_PORT (3000)  VERITY_PG_PORT (5433)
#   VERITY_DEPLOYMENT (testnet)                       which deployments/<name>.json
#   VERITY_REEXECUTORS ("rex1 rex2 rex3 rex4 rex5")   stellar-cli aliases
#   --no-web / --no-agents                            skip those processes
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck source=scripts/_deployment.sh
source "$ROOT_DIR/scripts/_deployment.sh"
require_deployment
refuse_public_deployment "pnpm dev is the local development runner; a public deployment runs from the container stack (docs/DEPLOY.md)."
refuse_mainnet_deployment "pnpm dev is the local development runner and must never run against mainnet (docs/MAINNET.md)."
assert_identities_match

API_PORT="${VERITY_API_PORT:-3001}"
WEB_PORT="${VERITY_WEB_PORT:-3000}"
PG_PORT="${VERITY_PG_PORT:-5433}"
REEXECUTORS="${VERITY_REEXECUTORS:-${BOOTSTRAP_REEXECUTORS[*]}}"
RUN_WEB=1
RUN_AGENTS=1
for arg in "$@"; do
  case "$arg" in
    --no-web) RUN_WEB=0 ;;
    --no-agents) RUN_AGENTS=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

GATE_ID="$(json_field escrow_gate_contract_id)"
REGISTRY_ID="$(json_field zk_verifier_registry_contract_id)"
# The gate's bond asset. A record written before the deploy script took
# VERITY_BOND_ASSET has only the native XLM address, which was the bond asset.
BOND_ASSET_ID="$(json_field bond_asset_sac_address 2>/dev/null || json_field native_xlm_sac_address)"
DATABASE_URL="postgres://verity:verity@127.0.0.1:${PG_PORT}/verity"

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

for port in "$API_PORT" $([ "$RUN_WEB" = 1 ] && echo "$WEB_PORT"); do
  if port_open "$port"; then
    echo "FATAL: port $port is already in use. Pick another with VERITY_API_PORT / VERITY_WEB_PORT." >&2
    exit 1
  fi
done

if [ ! -d node_modules ]; then
  echo "==> Installing dependencies"
  pnpm install
fi
if [ ! -f backend/src/chain/generated/escrow-gate/dist/index.js ]; then
  echo "==> Building contract bindings"
  pnpm --filter escrow-gate --filter zk-verifier-registry build
fi

if ! stellar keys address "$KEEPER" >/dev/null 2>&1; then
  echo "==> Creating and funding keeper identity '$KEEPER'"
  stellar keys generate "$KEEPER" --network "$NETWORK" --fund
fi

if [ -f backend/.env ] && grep -q '^KEEPER_SECRET_KEY=' backend/.env; then
  echo "WARN: backend/.env contains KEEPER_SECRET_KEY, which is unused by pnpm dev and can be deleted."
fi

if [ ! -f backend/.env ]; then
  echo "==> Creating backend/.env (gitignored)"
  (
    umask 077
    cat > backend/.env <<ENV
SOROBAN_RPC_URL=$SOROBAN_RPC_URL
NETWORK_PASSPHRASE="$NETWORK_PASSPHRASE"
ESCROW_GATE_CONTRACT_ID=$GATE_ID
ZK_VERIFIER_REGISTRY_CONTRACT_ID=$REGISTRY_ID
BOND_ASSET_CONTRACT_ID=$BOND_ASSET_ID
DATABASE_URL=$DATABASE_URL
WEB_AUTH_DOMAIN=localhost:$API_PORT
HOME_DOMAIN=localhost:$API_PORT
PORT=$API_PORT
ARTIFACT_STORAGE_DIR=./.artifacts
JWT_SECRET=$(openssl rand -hex 32)
ENV
  )
  chmod 600 backend/.env
fi

PIDS=()
cleanup() {
  trap - EXIT INT TERM
  echo
  echo "==> Stopping Verity"
  for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Each service runs in its own process group (so the whole tree — tsx, node,
# postgres — can be stopped together) with its output prefixed by name.
start() {
  local name="$1" dir="$2"; shift 2
  (cd "$dir" && exec setsid "$@") > >(sed -u "s/^/[$name] /") 2>&1 &
  PIDS+=("$!")
}

wait_for() {
  local what="$1" check="$2" pid="${3:-}" tries=0
  until eval "$check" >/dev/null 2>&1; do
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "FATAL: $what exited before it became ready" >&2
      exit 1
    fi
    tries=$((tries + 1))
    if [ "$tries" -gt 180 ]; then echo "FATAL: timed out waiting for $what" >&2; exit 1; fi
    sleep 1
  done
}

TSX="$ROOT_DIR/db/node_modules/.bin/tsx"

if port_open "$PG_PORT"; then
  echo "==> Postgres already listening on :$PG_PORT, reusing it"
else
  echo "==> Starting Postgres on :$PG_PORT (data in .pgdata/)"
  start postgres db "$TSX" src/dev-postgres-daemon.ts "$ROOT_DIR/.pgdata" "" "$PG_PORT"
  wait_for "Postgres" "port_open $PG_PORT" "${PIDS[-1]}"
fi

echo "==> Running migrations"
(cd db && DATABASE_URL="$DATABASE_URL" "$TSX" src/migrate.ts)

# The backend refuses a JWT secret shorter than 32 characters. An older
# backend/.env may hold one; rather than rewrite a file of secrets, this run
# gets a temporary one (every session ends when the stack stops).
JWT_OVERRIDE=()
current_jwt="$(grep -E '^JWT_SECRET=' backend/.env | head -1 | cut -d= -f2- | tr -d '"' || true)"
if [ "${#current_jwt}" -lt 32 ]; then
  echo "WARN: JWT_SECRET in backend/.env is shorter than 32 characters; using a temporary one for this run." >&2
  echo "      Replace it with the output of: openssl rand -hex 32" >&2
  JWT_OVERRIDE=(JWT_SECRET="$(openssl rand -hex 32)")
fi
unset current_jwt

echo "==> Starting backend on :$API_PORT"
export SOROBAN_RPC_URL NETWORK_PASSPHRASE
export ESCROW_GATE_CONTRACT_ID="$GATE_ID" ZK_VERIFIER_REGISTRY_CONTRACT_ID="$REGISTRY_ID" BOND_ASSET_CONTRACT_ID="$BOND_ASSET_ID"
# The keeper key comes from the keystore on every start, so backend/.env going
# stale after a redeploy or a deployment switch can never sign with the wrong one.
start backend backend env \
  DATABASE_URL="$DATABASE_URL" PORT="$API_PORT" \
  WEB_AUTH_DOMAIN="localhost:$API_PORT" HOME_DOMAIN="localhost:$API_PORT" \
  DEPLOYMENT_NAME="$DEPLOYMENT" KEEPER_SECRET_KEY="$(stellar keys secret "$KEEPER")" \
  "${JWT_OVERRIDE[@]}" \
  "$ROOT_DIR/backend/node_modules/.bin/tsx" src/index.ts
wait_for "backend" "curl -fs http://127.0.0.1:$API_PORT/health" "${PIDS[-1]}"

if [ "$RUN_AGENTS" = 1 ]; then
  for alias in $REEXECUTORS; do
    if ! secret="$(stellar keys secret "$alias" 2>/dev/null)"; then
      echo "WARN: no stellar-cli identity '$alias' — run scripts/deploy_testnet.sh + scripts/bootstrap_reexecutors.sh, skipping" >&2
      continue
    fi
    echo "==> Starting re-executor agent $alias"
    start "$alias" reexecutor-agent env \
      BACKEND_URL="http://127.0.0.1:$API_PORT" REEXECUTOR_SECRET_KEY="$secret" \
      "$ROOT_DIR/reexecutor-agent/node_modules/.bin/tsx" src/index.ts
  done
  unset secret
fi

if [ "$RUN_WEB" = 1 ]; then
  echo "==> Starting frontend on :$WEB_PORT"
  start frontend frontend env \
    BACKEND_URL="http://127.0.0.1:$API_PORT" NEXT_PUBLIC_NETWORK_PASSPHRASE="$NETWORK_PASSPHRASE" \
    "$ROOT_DIR/frontend/node_modules/.bin/next" dev --turbopack -p "$WEB_PORT"
fi

echo
echo "Verity is up (Ctrl+C stops everything):"
echo "  API       http://localhost:$API_PORT"
[ "$RUN_WEB" = 1 ] && echo "  Dashboard http://localhost:$WEB_PORT"
echo "  EscrowGate $GATE_ID (deployment '$DEPLOYMENT', $NETWORK)"
echo "  End-to-end check, in another terminal:  VERITY_API_PORT=$API_PORT pnpm smoke"
echo
wait
