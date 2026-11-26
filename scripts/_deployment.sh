# Sourced by the other scripts: resolves which Verity deployment they act on.
#
#   VERITY_DEPLOYMENT=testnet (default)  deployments/testnet.json, the dev and
#                                        smoke deployment, identities deployer,
#                                        keeper, rex1..rex5
#   VERITY_DEPLOYMENT=<name>             deployments/<name>.json, identities
#                                        verity-<name>-deployer,
#                                        verity-<name>-keeper,
#                                        verity-<name>-rex1..rex5
#
# The stellar-cli keystore is one flat namespace shared by every project on
# the machine, and another project that generates an identity called "keeper"
# or "deployer" silently replaces yours. Named deployments are therefore
# prefixed with "verity-"; the dev deployment keeps its short historical
# aliases, and every script checks them against the deployment record (see
# assert_identities_match) so a replaced key is reported, not used.
#
# Each deployment record carries its network ("testnet" or "mainnet"),
# network_passphrase and rpc_url (defaulting to Stellar testnet when absent).
# A deployment whose file says "public": true or "network": "mainnet" is one
# the dev runner and smoke test refuse to touch.
#
# Expects ROOT_DIR to be set by the caller.

DEPLOYMENT="${VERITY_DEPLOYMENT:-testnet}"
if ! [[ "$DEPLOYMENT" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "FATAL: VERITY_DEPLOYMENT must be lowercase letters, digits and dashes (got '$DEPLOYMENT')" >&2
  exit 2
fi
if [ "$DEPLOYMENT" = testnet ]; then
  ALIAS_PREFIX=""
else
  ALIAS_PREFIX="verity-$DEPLOYMENT-"
fi

TESTNET_PASSPHRASE="Test SDF Network ; September 2015"
TESTNET_RPC_URL="https://soroban-testnet.stellar.org"
MAINNET_PASSPHRASE="Public Global Stellar Network ; September 2015"
DEPLOY_JSON="$ROOT_DIR/deployments/$DEPLOYMENT.json"

DEPLOYER="${ALIAS_PREFIX}deployer"
KEEPER="${ALIAS_PREFIX}keeper"
BOOTSTRAP_REEXECUTORS=("${ALIAS_PREFIX}rex1" "${ALIAS_PREFIX}rex2" "${ALIAS_PREFIX}rex3" "${ALIAS_PREFIX}rex4" "${ALIAS_PREFIX}rex5")

# The record is flattened onto one line and matched with optional whitespace
# around ":" and ",", so pretty-printing deployments/<name>.json (or a space
# before a colon) does not change what these return.
_deployment_flat() { tr -d '\n\r' < "$DEPLOY_JSON"; }

# Prints the string value of a top-level key when the deployment file and key
# exist, or nothing otherwise. Used for network settings with testnet defaults
# so existing records without rpc_url keep working unchanged.
json_field_or_empty() {
  [ -f "$DEPLOY_JSON" ] || return 0
  _deployment_flat | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | sed 's/.*"\([^"]*\)"$/\1/' || true
}

# Prints the string value of a top-level key. A missing key says so and fails;
# under `set -e` the caller would otherwise stop with no message at all.
json_field() {
  local value
  value="$(json_field_or_empty "$1")"
  if [ -z "$value" ]; then
    echo "FATAL: '$1' not found in $DEPLOY_JSON" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

_CALLER_SOROBAN_RPC_URL="${SOROBAN_RPC_URL:-}"
NETWORK="$(json_field_or_empty network)"
NETWORK="${NETWORK:-testnet}"
if [ "$NETWORK" != testnet ] && [ "$NETWORK" != mainnet ]; then
  echo "FATAL: unsupported network '$NETWORK' in $DEPLOY_JSON (expected 'testnet' or 'mainnet')" >&2
  exit 1
fi
NETWORK_PASSPHRASE="$(json_field_or_empty network_passphrase)"
if [ -z "$NETWORK_PASSPHRASE" ]; then
  if [ "$NETWORK" = mainnet ]; then
    NETWORK_PASSPHRASE="$MAINNET_PASSPHRASE"
  else
    NETWORK_PASSPHRASE="$TESTNET_PASSPHRASE"
  fi
fi
SOROBAN_RPC_URL="$(json_field_or_empty rpc_url)"
if [ -z "$SOROBAN_RPC_URL" ]; then
  if [ -n "$_CALLER_SOROBAN_RPC_URL" ]; then
    SOROBAN_RPC_URL="$_CALLER_SOROBAN_RPC_URL"
  elif [ "$NETWORK" = testnet ]; then
    SOROBAN_RPC_URL="$TESTNET_RPC_URL"
  fi
fi

deployment_is_public() { _deployment_flat | grep -E '"public"[[:space:]]*:[[:space:]]*true' >/dev/null; }
deployment_is_mainnet() { [ "$NETWORK" = mainnet ]; }

# The public key recorded for a bootstrap re-executor alias, or nothing.
recorded_reexecutor_key() {
  _deployment_flat \
    | grep -o "\"alias\"[[:space:]]*:[[:space:]]*\"$1\"[^}]*\"public_key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | sed 's/.*"\([^"]*\)"$/\1/' || true
}

# Exits non-zero naming every missing tool, instead of a bare
# "command not found" partway through a run.
require_commands() {
  local missing=() cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "FATAL: missing required tool(s): ${missing[*]} — install them and re-run" >&2
    exit 1
  fi
}

require_deployment() {
  if [ ! -f "$DEPLOY_JSON" ]; then
    echo "FATAL: $DEPLOY_JSON not found — run scripts/deploy_testnet.sh first" >&2
    exit 1
  fi
}

# Fails if the deployer or a fleet re-executor in the keystore is no longer
# the account the deployment record names: the deployer is the contract's
# admin and each re-executor holds a stake, so a different key under the same
# alias cannot stand in for them. The keeper is different — it has no
# authority on-chain and any funded account can do its job — so a changed
# keeper is reported and the keystore's current one is used.
assert_identities_match() {
  local problems=0 recorded current alias
  recorded="$(json_field deployer_public_key 2>/dev/null || true)"
  current="$(stellar keys address "$DEPLOYER" 2>/dev/null || true)"
  if [ -n "$recorded" ] && [ "$recorded" != "$current" ]; then
    echo "FATAL: keystore identity '$DEPLOYER' is ${current:-missing}, but the admin of deployment '$DEPLOYMENT' is $recorded." >&2
    problems=1
  fi
  for alias in "${BOOTSTRAP_REEXECUTORS[@]}"; do
    recorded="$(recorded_reexecutor_key "$alias")"
    current="$(stellar keys address "$alias" 2>/dev/null || true)"
    if [ -z "$recorded" ]; then
      echo "WARN: deployment '$DEPLOYMENT' records no key for '$alias', so that identity is not checked." >&2
    elif [ -n "$current" ] && [ "$recorded" != "$current" ]; then
      echo "FATAL: keystore identity '$alias' is $current, but deployment '$DEPLOYMENT' staked $recorded under that name." >&2
      problems=1
    fi
  done
  if [ "$problems" = 1 ]; then
    echo "       Another project has probably generated an identity with the same name. Restore the" >&2
    echo "       original key into the keystore, or redeploy (scripts/deploy_testnet.sh --force)." >&2
    exit 1
  fi
  recorded="$(json_field keeper_public_key 2>/dev/null || true)"
  current="$(stellar keys address "$KEEPER" 2>/dev/null || true)"
  if [ -n "$recorded" ] && [ -n "$current" ] && [ "$recorded" != "$current" ]; then
    echo "WARN: keystore identity '$KEEPER' is $current, not the $recorded recorded at deploy time." >&2
    echo "      The keeper needs no authority on-chain, so this one is used; verdict attestations will be signed by it." >&2
  fi
}

refuse_public_deployment() {
  if deployment_is_public; then
    echo "FATAL: deployment '$DEPLOYMENT' is marked public. $1" >&2
    exit 1
  fi
}

refuse_mainnet_deployment() {
  if deployment_is_mainnet; then
    echo "FATAL: deployment '$DEPLOYMENT' is on mainnet. $1" >&2
    exit 1
  fi
}
