# Deploying Verity for other people to use

This is the runbook for a public testnet deployment: its own contracts, its
own keys, a database that starts empty, and the stack running from container
images on any host. Local development is `pnpm dev` (see the README) and is
deliberately a separate deployment.

## What you are running

| Piece | Image | Notes |
|---|---|---|
| Postgres | `postgres:18-alpine` | Mirror of chain state, plus artifacts metadata. Not exposed. |
| Backend | `backend/Dockerfile` | API, chain indexer, keeper. **Run exactly one with workers on.** |
| Dashboard | `frontend/Dockerfile` | Next.js. Talks to the backend over the internal network. |
| Re-executors | `reexecutor-agent/Dockerfile` | Your own fleet, at least a quorum (3). Optional `fleet` profile. |

The images need nothing special from the host: no Docker socket, no extra
capabilities. Submitted functions run in a WebAssembly sandbox inside the
re-executor process.

## 1. Create the deployment (once, from your own machine)

You need `stellar-cli` and Rust. Keys are created in your stellar-cli keystore
and never leave it except where you copy them in step 2.

```bash
VERITY_DEPLOYMENT=public scripts/deploy_testnet.sh --public
VERITY_DEPLOYMENT=public scripts/bootstrap_reexecutors.sh
```

The first command deploys a fresh EscrowGate and ZKVerifierRegistry, each
configured in the same transaction that creates it, and writes
`deployments/public.json`. It creates the identities `verity-public-deployer` (the
contract admin), `verity-public-keeper` and `verity-public-rex1..5`. The second stakes the
five re-executors and approves them as voters.

`--public` marks the deployment so that `pnpm dev` and `pnpm smoke` refuse to
run against it. Test submissions are real on-chain records; they must never
land on the contract your users see. A public deployment also gets the real
challenge windows (1 hour, or 24 hours from 100,000 XLM of escrow value)
rather than the 10-minute dev windows.

Commit `deployments/public.json`. It holds contract IDs and public keys only.

## 2. Configure

On the host, in a checkout of this repository:

```bash
cp .env.example .env
```

Fill it in from `deployments/public.json` and your keystore:

| Variable | Value |
|---|---|
| `ESCROW_GATE_CONTRACT_ID`, `ZK_VERIFIER_REGISTRY_CONTRACT_ID`, `BOND_ASSET_CONTRACT_ID` | `escrow_gate_contract_id`, `zk_verifier_registry_contract_id`, `native_xlm_sac_address` |
| `WEB_AUTH_DOMAIN`, `HOME_DOMAIN` | The public host of the **API**, e.g. `api.verity.example` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `KEEPER_SECRET_KEY` | `stellar keys secret verity-public-keeper` |
| `SEP10_SIGNING_SECRET` | `stellar keys generate verity-public-sep10 && stellar keys secret verity-public-sep10` |
| `REX1..5_SECRET_KEY` | `stellar keys secret verity-public-rex1` … `verity-public-rex5` |

The **admin key (`verity-public-deployer`) does not go on the server.** It is only
used from your own machine, to approve re-executors and change contract
configuration.

Keep the keeper account funded: it pays the fee for every finalize, challenge
resolution and lock release. `stellar keys fund verity-public-keeper --network testnet`
tops it up.

## 3. Start it

> **Note on docker-compose.yml:** The container images build and the full stack
> has been run from them with services started one by one, but `docker-compose.yml`
> itself has not been executed end-to-end as the development environment lacked a
> compose provider.

```bash
docker compose --profile fleet up -d --build
docker compose ps
curl -s http://127.0.0.1:3001/health
```

`/health` answers `200` with `"ok": true` once the database, the Soroban RPC
and the indexer are all in order, and reports which deployment and contract
this backend serves. `/health/live` only says the process is up.

Without `--profile fleet` you get everything except the re-executors.

### Running fewer re-executors

In a default deployment, the contract requires a quorum of three re-executors
(`quorum_min_reexecutors: 3` configured by `scripts/deploy_testnet.sh`). If fewer
than three workers are online, no consensus can form; contested work cannot be
resolved through re-execution and verdicts will only resolve once challenge
windows elapse (`window_elapsed`).

To start only three workers instead of all five:

```bash
docker compose --profile fleet up -d --build backend frontend reexecutor-1 reexecutor-2 reexecutor-3
```

**Restart-loop caveat:** Leaving any `REXn_SECRET_KEY` empty while its corresponding
service is started causes that container to fail and enter a restart loop. Only
start the specific `reexecutor-N` services for which you have configured secret keys.
Note that `scripts/bootstrap_reexecutors.sh` automatically stakes and approves all
five identities (`verity-public-rex1..5`).

### Running a standalone re-executor worker

A worker can be built and run on a separate host without the rest of the compose stack:

```bash
docker build -f reexecutor-agent/Dockerfile -t verity-reexecutor .
docker run -d --restart unless-stopped --env-file worker.env verity-reexecutor
```

Where `worker.env` contains:
```env
BACKEND_URL=https://api.verity.example
REEXECUTOR_SECRET_KEY=S...
ESCROW_GATE_CONTRACT_ID=C...
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
# Optional:
POLL_INTERVAL_MS=3000
RETRIEVAL_RETRY_BUDGET_S=120
CONNECTIVITY_CHECK_URL=https://soroban-testnet.stellar.org
```

**Prerequisites:** The account corresponding to `REEXECUTOR_SECRET_KEY` must be
staked above the on-chain floor (500 XLM, via dashboard under Re-executors → Register)
and approved by the deployment admin (`scripts/approve_reexecutor.sh G...`).
Otherwise, the worker logs that no work will be assigned and idles. No prebuilt
image is published; it must be built from the repository.

## 4. Put HTTPS in front

The containers listen on `127.0.0.1` only. Terminate TLS with any reverse
proxy and route two hosts:

| Public host | To |
|---|---|
| `verity.example` | `127.0.0.1:3000` (dashboard) |
| `api.verity.example` | `127.0.0.1:3001` (backend) |

HTTPS is required, not optional: the sign-in cookie is `Secure` in production,
so sign-in does not work over plain HTTP.

The API must be publicly reachable because other people's re-executor workers
poll it. Your proxy **must overwrite `X-Forwarded-For`** with the real client
address rather than pass through whatever the client sent: the backend trusts
that header for rate limiting.

With Caddy the whole configuration is:

```
verity.example {
	reverse_proxy 127.0.0.1:3000
}
api.verity.example {
	reverse_proxy 127.0.0.1:3001
}
```

## 5. Day to day

**Approving a re-executor.** Anyone can stake from the dashboard; their
account then shows as "Pending approval". To let it vote, from your machine:

```bash
VERITY_DEPLOYMENT=public scripts/approve_reexecutor.sh G...
VERITY_DEPLOYMENT=public scripts/approve_reexecutor.sh G... --revoke
```

**One backend with workers.** The indexer owns the chain cursor and the keeper
signs with one account sequence, so only one backend process may run them. To
scale the API, run more backends with `RUN_WORKERS=false`.

**Backup and restore.** State is held in two Docker volumes (`pgdata` at
`/var/lib/postgresql` and `backend_artifacts` at `/app/backend/.artifacts`).
Both should be backed up together:

- *Postgres backup:*
  ```bash
  docker compose exec -T postgres pg_dump -U verity -d verity > verity_backup.sql
  ```
- *Postgres restore (into clean database):*
  ```bash
  docker compose exec -T postgres psql -U verity -d verity < verity_backup.sql
  ```
- *Artifacts backup:*
  ```bash
  docker compose run --rm --entrypoint tar backend czf - -C /app/backend/.artifacts . > artifacts_backup.tar.gz
  ```
- *Artifacts restore:*
  ```bash
  docker compose run --rm --entrypoint tar backend xzf - -C /app/backend/.artifacts < artifacts_backup.tar.gz
  ```

Postgres can be reconstructed from chain events only within the RPC's event retention
window (about 7 days). The artifacts cannot be rebuilt from chain events at all; if
they are lost, function replay and retrieval checking will fail.

**Monitoring keeper balance.** The keeper pays transaction fees for `finalize`,
`resolve_challenge`, and `release_attestation_lock`. If the keeper account runs out of XLM, the scheduler
fails to submit transactions and logs lines like `[scheduler] finalize failed`,
`[scheduler] resolve_challenge failed`, or `[scheduler] settlement failed`
(visible with `docker compose logs backend`).

Check the balance via Horizon:
```bash
curl -s https://horizon-testnet.stellar.org/accounts/<KEEPER_PUBLIC_KEY> | jq '.balances[] | select(.asset_type=="native") | .balance'
```
Top it up whenever it runs low:
```bash
stellar keys fund verity-public-keeper --network testnet
```

**Contract TTL and archival.** The command below extends the contract's instance
TTL (which also covers contract code):

```bash
stellar contract extend --id <ESCROW_GATE_CONTRACT_ID> --source verity-public-keeper \
  --network testnet --durability persistent --ledgers-to-extend 500000
```

Per-key persistent storage entries (such as individual submissions and re-executors)
are extended automatically when written or modified by transactions, setting their
TTL to 500,000 ledgers (approximately 29 days at ~5s per ledger). If an entry is untouched
for longer than that, Soroban archives it. To restore an archived contract instance:
```bash
stellar contract restore --id <ESCROW_GATE_CONTRACT_ID> --source verity-public-keeper --network testnet
```
Note: Restoring individual archived contract data keys requires `--key-xdr <BASE64_KEY>`,
which requires constructing the raw XDR representation of `DataKey` (e.g. `DataKey::Submission(u64)`).
Because constructing raw XDR storage keys by hand is impractical, ensure entries in
active dispute are touched before their 29-day lifetime expires.

**Loss of admin key.** `verity-public-deployer` is the only identity authorized to
call `update_config` and `set_reexecutor_approved` on `EscrowGate`. `EscrowGate` has
no admin-transfer or contract upgrade entrypoints. If the admin secret key is lost:
- Existing submissions, challenges, and voting continue functioning according to the live configuration.
- No new re-executors can be approved, and existing approvals cannot be revoked.
- Configuration parameters (challenge windows, fee rates, bonds) cannot be modified.
- Forfeited agent bonds without challengers that are paid to the admin address in `settle` will accumulate permanently in that account and cannot be recovered.

**Testnet resets.** Stellar testnet is wiped periodically. After a reset the
contracts are gone: repeat step 1 with `--force --replace-public` (the public-deployment guard requires `--replace-public` because replacing it abandons the old contracts), update `.env`, and start
from an empty database (`docker compose down -v` deletes both volumes).

**Upgrading.** EscrowGate has no upgrade entrypoint. A backend, dashboard or
worker change is `git pull && docker compose --profile fleet up -d --build`.
A contract change is a new deployment: step 1 with `--force --replace-public`, then as for a
testnet reset. Stakes on the old contract stay withdrawable from it.

### Tuning

The backend validates these optional settings at startup. All are positive
integers except `REPLAY_OVERASSIGN` and `DB_STATEMENT_TIMEOUT_MS`, which also accept `0`, and
`ATTESTATION_SIGNING_SECRET`, which is a Stellar secret key.

| Variable | Default | What it does |
|---|---|---|
| `REEXECUTOR_LIVENESS_S` | `60` | Seconds since a worker's last assignment poll or heartbeat during which it counts as online. Only online, active re-executors (and approved ones when the allowlist is enabled) receive assignments. Keep this well above the agent's `POLL_INTERVAL_MS` (default `3000` ms) and `HEARTBEAT_INTERVAL_MS` (default `15000` ms). |
| `REPLAY_OVERASSIGN` | `1` | Extra re-executors beyond the contract quorum for deterministic tasks or tasks escalated to full quorum; `0` disables spares. |
| `REPLAY_REASSIGN_AFTER_S` | `120` | After this many seconds unanswered, an assignment stops counting toward quorum and another live worker is asked. The original row stays and a late vote still counts. At settlement, an unanswered assignment that had at least this long before finalisation is marked missed; younger ones are dropped without a mark. |
| `DRAFT_TTL_S` | `3600` | Scheduler deletes drafts with no on-chain submission after this many seconds since `updated_at`; rebuilding a draft transaction restarts its age. Must outlast the built transaction's validity. |
| `ARTIFACT_MAX_BYTES` | `262144` | Maximum decoded artifact size accepted by `POST /v1/artifacts`; larger artifacts return HTTP 413. |
| `ARTIFACT_MAX_TOTAL_BYTES` | `10737418240` (10 GiB) | Cap on everything in `ARTIFACT_STORAGE_DIR`. An upload of new content that would pass it returns HTTP 507; content already stored is never refused. Size the volume above this. Artifacts are never deleted, so raise it, or prune unreferenced files, as the store fills. |
| `ARTIFACT_UPLOADS_PER_MINUTE` | `30` | Uploads per minute per account **and** per client address on `POST /v1/artifacts`, on top of the general limits. Rotating tokens does not raise it. |
| `DB_POOL_MAX` | `10` | Maximum concurrent connections in the Postgres pool. Read by the database package, not `env.ts`. |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | Milliseconds before a query is cancelled; `0` disables the timeout. |
| `ATTESTATION_SIGNING_SECRET` | the keeper key | Stellar secret key that signs verdict attestations. Give it its own key so rotating the fund-moving keeper key does not change every future attestation's signer. |
| `RATE_LIMIT_PER_MINUTE` | `300` | Requests per minute per client address, and again per account with a valid bearer token. Both apply, so extra accounts do not add address budget. `/health*` is exempt; `X-Forwarded-For` supplies the address only with `TRUST_PROXY=true`. |
| `AUTH_REQUESTS_PER_MINUTE` | `20` | Requests per minute per client address to `GET /auth` and `POST /auth`, which mint identities. Far below `RATE_LIMIT_PER_MINUTE` so signing in as many accounts is slow. |

Outside Docker, add these settings to `backend/.env`, loaded by `dotenv`,
and restart the backend. `backend/.env.example` shows commented defaults;
uncomment only the values you want to override.

The current `docker-compose.yml` passes a fixed `backend.environment` list
and has no `env_file`; it does **not** forward these variables. Adding
them to the root `.env` or `backend/.env` alone does not configure the
container. Defaults apply unless you also add the desired variables to the
backend service's `environment` mapping (or a Compose override) and recreate
the backend container. This repository's Compose file is unchanged here.

Request bodies are limited to 1,048,576 bytes (1 MiB), except on
`POST /v1/artifacts`. That route takes the artifact as base64 inside JSON, four
characters for every three bytes, so its limit is computed from
`ARTIFACT_MAX_BYTES`: the base64 length of that many bytes plus 4,096 bytes for
the JSON around it. Raising `ARTIFACT_MAX_BYTES` raises the usable upload size
with it. An artifact a little over the limit is answered with the 413 that
names the limit; a request far over it is refused while the body is being
read, with the generic 413. An upload is held in memory while it is handled,
so choose the value with that in mind. Neither body limit is an environment
setting of its own.

## What this deployment does not give you

- It is Stellar testnet. The XLM has no value, the contracts are unaudited.
- Stake is free on testnet, which is why the voter set is admin-approved.
  That is a real admin power: you decide who may vote. You cannot set a verdict.
- Webhooks are delivered once, with no retry.
- Artifacts live on one host's disk.
