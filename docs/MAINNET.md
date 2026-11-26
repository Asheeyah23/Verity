# Mainnet readiness checklist

**Verity is not ready for Stellar mainnet.** The contracts are unaudited
([`SECURITY.md:4-5`](../SECURITY.md), [`README.md:666`](../README.md)), bonds
and stakes are wired to native XLM, the contract admin is a single key with no
transfer or upgrade entrypoint, and the backend runs as a single worker node
storing artifacts on one local disk. Do not treat any current deployment as safe
for real value.

This document lists every known blocker between the current testnet system and a
mainnet deployment, its status (`missing`, `partial`, or `done`), where it
lives in the repository today, what "done" means, and who owns it.

## Summary

| Section | Item | Status | Owner | Code / doc references |
|---|---|---|---|---|
| [1. Contracts](#1-contracts) | Independent security audit | `missing` | Contracts / Security | [`SECURITY.md:4-5`](../SECURITY.md), [`README.md:666`](../README.md), [`contracts/escrow-gate/src/lib.rs`](../contracts/escrow-gate/src/lib.rs), [`contracts/zk-verifier-registry/src/lib.rs`](../contracts/zk-verifier-registry/src/lib.rs) |
| [1. Contracts](#1-contracts) | Fuzz and property-based coverage | `partial` | Contracts | [`contracts/escrow-gate/src/test/proptest_model.rs`](../contracts/escrow-gate/src/test/proptest_model.rs), [`contracts/escrow-gate/src/test.rs`](../contracts/escrow-gate/src/test.rs) |
| [1. Contracts](#1-contracts) | Admin transfer and upgrade policy | `missing` | Contracts / Governance | [`contracts/escrow-gate/src/lib.rs:242-293`](../contracts/escrow-gate/src/lib.rs), [`contracts/escrow-gate/src/storage.rs:6-20`](../contracts/escrow-gate/src/storage.rs), [`docs/DEPLOY.md:243-258`](DEPLOY.md) |
| [2. Keys](#2-keys) | Admin as a multisig G-account | `partial` | Operator / Security | [`contracts/escrow-gate/src/lib.rs:256-293`](../contracts/escrow-gate/src/lib.rs), [`scripts/deploy_testnet.sh`](../scripts/deploy_testnet.sh), [`scripts/approve_reexecutor.sh`](../scripts/approve_reexecutor.sh), [`backend/src/auth/sep10.ts:30-54`](../backend/src/auth/sep10.ts) |
| [2. Keys](#2-keys) | Keeper funding, monitoring, and rotation | `partial` | Operator / Backend | [`backend/src/chain/keeper.ts:11-24`](../backend/src/chain/keeper.ts), [`docs/DEPLOY.md:69-71`](DEPLOY.md), [`docs/DEPLOY.md:208-221`](DEPLOY.md) |
| [2. Keys](#2-keys) | Separate `SEP10_SIGNING_SECRET` and `ATTESTATION_SIGNING_SECRET` | `partial` | Backend / Operator | [`backend/src/config/env.ts:37-43`](../backend/src/config/env.ts), [`backend/src/auth/sep10.ts:10-12`](../backend/src/auth/sep10.ts), [`backend/src/modules/attestations/export.ts:11-13`](../backend/src/modules/attestations/export.ts), [`docker-compose.yml:76-78`](../docker-compose.yml), [`docs/DEPLOY.md:277`](DEPLOY.md) |
| [3. Assets](#3-assets) | USDC / SEP-41 non-native bond and stake asset | `partial` | Contracts / Backend / Frontend | [`contracts/escrow-gate/src/lib.rs:242-249`](../contracts/escrow-gate/src/lib.rs), [`scripts/deploy_testnet.sh`](../scripts/deploy_testnet.sh), [`backend/src/modules/config/routes.ts:15`](../backend/src/modules/config/routes.ts), [`frontend/src/lib/format.ts`](../frontend/src/lib/format.ts) |
| [4. Operations](#4-operations) | Network as a deployment setting & explorer/Friendbot gating | `done` | Infrastructure / Frontend | [`scripts/_deployment.sh`](../scripts/_deployment.sh), [`scripts/deploy_testnet.sh`](../scripts/deploy_testnet.sh), [`scripts/dev.sh`](../scripts/dev.sh), [`scripts/smoke.sh`](../scripts/smoke.sh), [`frontend/src/lib/config.ts`](../frontend/src/lib/config.ts), [`frontend/src/components/fund-account-button.tsx`](../frontend/src/components/fund-account-button.tsx), [`frontend/src/app/api/friendbot/route.ts`](../frontend/src/app/api/friendbot/route.ts) |
| [4. Operations](#4-operations) | Mainnet Soroban RPC provider choice and compose defaults | `missing` | Operator / Infrastructure | [`docker-compose.yml:12-13`](../docker-compose.yml), [`docs/DEPLOY.md:126-131`](DEPLOY.md), [`docs/ARCHITECTURE.md:138-139`](ARCHITECTURE.md) |
| [4. Operations](#4-operations) | Automated contract and persistent entry TTL extension job | `partial` | Backend / Contracts | [`contracts/escrow-gate/src/storage.rs:24-38`](../contracts/escrow-gate/src/storage.rs), [`docs/DEPLOY.md:223-241`](DEPLOY.md) |
| [4. Operations](#4-operations) | Off-host backups and shared artifact storage | `missing` | Operator / Backend | [`backend/src/modules/artifacts/routes.ts:15-73`](../backend/src/modules/artifacts/routes.ts), [`docker-compose.yml:84-88`](../docker-compose.yml), [`docs/DEPLOY.md:183-206`](DEPLOY.md), [`README.md:686-687`](../README.md) |
| [4. Operations](#4-operations) | Second backend instance, worker failover, and webhook retries | `partial` | Backend / Infrastructure | [`backend/src/config/env.ts:60-62`](../backend/src/config/env.ts), [`backend/src/chain/keeper.ts:19-24`](../backend/src/chain/keeper.ts), [`backend/src/workers/indexer.ts`](../backend/src/workers/indexer.ts), [`backend/src/modules/webhooks/dispatcher.ts:157-188`](../backend/src/modules/webhooks/dispatcher.ts), [`README.md:529-537`](../README.md), [`README.md:686-687`](../README.md) |
| [5. Product](#5-product) | Open voter set versus `reexecutor_allowlist` | `partial` | Product / Contracts / Backend | [`contracts/escrow-gate/src/lib.rs:268-293`](../contracts/escrow-gate/src/lib.rs), [`contracts/escrow-gate/src/lib.rs:480-482`](../contracts/escrow-gate/src/lib.rs), [`backend/src/modules/reexecutors/assignment.ts`](../backend/src/modules/reexecutors/assignment.ts), [`docs/DEPLOY.md:301-302`](DEPLOY.md), [`README.md:673-681`](../README.md) |
| [6. Legal and treasury](#6-legal-and-treasury) | Destination and custody of forfeited bonds and slashed stakes | `missing` | Legal / Treasury / Contracts | [`contracts/escrow-gate/src/lib.rs:140-159`](../contracts/escrow-gate/src/lib.rs), [`contracts/escrow-gate/src/lib.rs:212-230`](../contracts/escrow-gate/src/lib.rs), [`docs/DEPLOY.md:243-249`](DEPLOY.md) |

---

## 1. Contracts

### 1.1 Independent security audit

- **Status:** `missing`
- **Owner:** Contracts / Security
- **Current state:** Both [`contracts/escrow-gate/src/lib.rs`](../contracts/escrow-gate/src/lib.rs) and [`contracts/zk-verifier-registry/src/lib.rs`](../contracts/zk-verifier-registry/src/lib.rs) are unaudited, as stated in [`SECURITY.md:4-5`](../SECURITY.md), [`README.md:666`](../README.md), and [`docs/DEPLOY.md:300`](DEPLOY.md). `EscrowGate` custodies agent bonds, challenger bonds, and re-executor stakes and transfers them on terminal verdicts and lock releases ([`settle` at `contracts/escrow-gate/src/lib.rs:125-169`](../contracts/escrow-gate/src/lib.rs) and [`apply_slash` at `contracts/escrow-gate/src/lib.rs:193-233`](../contracts/escrow-gate/src/lib.rs)).
- **What "done" means:** Commission and complete an independent security audit covering `contracts/escrow-gate`, `contracts/zk-verifier-registry`, `contracts/common`, transaction relay validation in [`backend/src/chain/rpc.ts:20-70`](../backend/src/chain/rpc.ts), and the QuickJS/retrieval replay sandbox in [`reexecutor-agent/src/sandbox/`](../reexecutor-agent/src/sandbox/). All critical, high, and medium findings must be fixed, re-verified by the auditors, and linked from [`SECURITY.md`](../SECURITY.md).

### 1.2 Fuzz and property-based coverage

- **Status:** `partial`
- **Owner:** Contracts
- **Current state:** [`contracts/escrow-gate/src/test/proptest_model.rs:1-138`](../contracts/escrow-gate/src/test/proptest_model.rs) runs a 64-case `proptest` model checking `finalize()` supermajority arithmetic against an independent reference implementation, alongside unit tests in [`contracts/escrow-gate/src/test.rs`](../contracts/escrow-gate/src/test.rs) and [`contracts/zk-verifier-registry/src/test.rs`](../contracts/zk-verifier-registry/src/test.rs). There is no stateful property or fuzz harness that generates arbitrary interleaved action sequences across `submit`, `attest_replay`, `open_challenge`, `resolve_challenge`, `finalize`, `release_attestation_lock`, `slash`, `withdraw_stake`, and `update_config`.
- **What "done" means:** Add stateful property/fuzz tests that run thousands of randomized multi-submission, multi-voter lifecycles and verify every PRD §8 invariant plus exact token conservation (`contract token balance == sum(active re-executor stakes) + sum(unsettled agent and challenger bonds)`) after every step.

### 1.3 Admin transfer and upgrade policy

- **Status:** `missing`
- **Owner:** Contracts / Governance
- **Current state:** [`EscrowGate::__constructor` (`contracts/escrow-gate/src/lib.rs:242-249`)](../contracts/escrow-gate/src/lib.rs) and [`ZkVerifierRegistry::__constructor` (`contracts/zk-verifier-registry/src/lib.rs:33-38`)](../contracts/zk-verifier-registry/src/lib.rs) store a single `DataKey::Admin` address in instance storage ([`contracts/escrow-gate/src/storage.rs:40-46`](../contracts/escrow-gate/src/storage.rs)). Neither contract provides an admin-transfer entrypoint (`transfer_admin` / `accept_admin`) or a WASM upgrade entrypoint (`update_current_contract_wasm`). As documented in [`docs/DEPLOY.md:243-258`](DEPLOY.md) and [`README.md:289-295`](../README.md), losing the admin key permanently freezes `update_config` and `set_reexecutor_approved`, and upgrading contract code requires deploying a brand-new contract ID and having every re-executor withdraw and re-stake.
- **What "done" means:** Add a two-step admin transfer (`propose_admin` + `accept_admin` requiring auth from both addresses) and decide the upgrade policy: either remain deliberately immutable per version with a documented drain/migration procedure for moving stakes and marketplaces to a new contract ID, or add a time-locked/multisig-gated upgrade entrypoint covered by the security audit.

---

## 2. Keys

### 2.1 Admin as a multisig G-account

- **Status:** `partial`
- **Owner:** Operator / Security
- **Current state:** On-chain admin checks in [`contracts/escrow-gate/src/lib.rs:256-293`](../contracts/escrow-gate/src/lib.rs) (`update_config` and `set_reexecutor_approved`) and [`contracts/zk-verifier-registry/src/lib.rs:146-157`](../contracts/zk-verifier-registry/src/lib.rs) call Soroban's `admin.require_auth()`. On Stellar, classic M-of-N weighted multisig on a standard `G...` account satisfies `require_auth()` without contract changes. However, [`scripts/deploy_testnet.sh`](../scripts/deploy_testnet.sh) and [`scripts/approve_reexecutor.sh:26-40`](../scripts/approve_reexecutor.sh) assume the admin is a single local `stellar-cli` identity (`DEPLOYER`) that can sign and submit in one step ([`docs/DEPLOY.md:23-35`](DEPLOY.md), [`docs/DEPLOY.md:243-249`](DEPLOY.md)). Note also that off-chain SEP-10 login verification in [`backend/src/auth/sep10.ts:30-54`](../backend/src/auth/sep10.ts) checks single-key signature presence rather than Horizon signer weights.
- **What "done" means:** Provision the mainnet admin as an M-of-N classic multisig G-account with signers on separate hardware keys; update admin scripts (`approve_reexecutor.sh` and config updates) to support building unsigned transaction XDR for offline multi-party signing and submission.

### 2.2 Keeper funding, monitoring, and rotation

- **Status:** `partial`
- **Owner:** Operator / Backend
- **Current state:** The keeper ([`backend/src/chain/keeper.ts:11-24`](../backend/src/chain/keeper.ts)) is a hot key (`KEEPER_SECRET_KEY`) on the backend server that signs and pays fees for permissionless maintenance calls: `finalize`, `resolve_challenge`, and `release_attestation_lock` ([`backend/src/chain/actions.ts:52-100`](../backend/src/chain/actions.ts), [`docs/DEPLOY.md:69-71`](DEPLOY.md)). Because those entrypoints are permissionless on-chain, the keeper holds no privileged contract role and can be rotated at any time ([`scripts/_deployment.sh:93-95,119-124`](../scripts/_deployment.sh)). However, [`docs/DEPLOY.md:208-221`](DEPLOY.md) relies on manual balance checks and testnet Friendbot top-ups (`stellar keys fund`). If the keeper runs out of XLM, finalisation and stake-lock release stop.
- **What "done" means:** Add automated low-balance alerting and health reporting for the keeper account, define a mainnet XLM funding and key-rotation runbook, and cap per-transaction fee budgets so fee spikes cannot drain the hot wallet unchecked.

### 2.3 Separate `SEP10_SIGNING_SECRET` and `ATTESTATION_SIGNING_SECRET`

- **Status:** `partial`
- **Owner:** Backend / Operator
- **Current state:** [`backend/src/config/env.ts:37-43`](../backend/src/config/env.ts) supports separate `SEP10_SIGNING_SECRET` and `ATTESTATION_SIGNING_SECRET` environment variables, but both are optional and fall back to `KEEPER_SECRET_KEY` ([`backend/src/auth/sep10.ts:10-12`](../backend/src/auth/sep10.ts), [`backend/src/modules/attestations/export.ts:11-13`](../backend/src/modules/attestations/export.ts)). [`docker-compose.yml:77`](../docker-compose.yml) and [`.env.example:47`](../.env.example) require `SEP10_SIGNING_SECRET`, but [`docker-compose.yml:72-87`](../docker-compose.yml) does not forward `ATTESTATION_SIGNING_SECRET` ([`docs/DEPLOY.md:277,284-289`](DEPLOY.md)), and `deployments/<name>.json` records only `keeper_public_key` ([`README.md:565-575`](../README.md)).
- **What "done" means:** Require distinct `KEEPER_SECRET_KEY`, `SEP10_SIGNING_SECRET`, and `ATTESTATION_SIGNING_SECRET` keys on public/mainnet deployments (refusing startup if any two share a keypair), pass `ATTESTATION_SIGNING_SECRET` through [`docker-compose.yml`](../docker-compose.yml) and [`.env.example`](../.env.example), and record `attestation_public_key` in `deployments/<name>.json` so rotating the fee-paying keeper key never invalidates or changes the attestation signer.

---

## 3. Assets

### 3.1 USDC bonds and stakes (SEP-41 token support)

- **Status:** `partial`
- **Owner:** Contracts / Backend / Frontend
- **Current state:** `EscrowGate` stores a `bond_asset: Address` in instance storage ([`contracts/escrow-gate/src/lib.rs:242-249`](../contracts/escrow-gate/src/lib.rs), [`contracts/escrow-gate/src/storage.rs:48-54`](../contracts/escrow-gate/src/storage.rs)) and uses `soroban_sdk::token::TokenClient` (the SEP-41 token interface) for every bond and stake transfer. However, the deployment tooling, API, and UI are hard-wired to native XLM:
  - [`scripts/deploy_testnet.sh`](../scripts/deploy_testnet.sh) resolves `stellar contract id asset --asset native` and passes it as `--bond_asset`.
  - [`backend/src/modules/config/routes.ts:15`](../backend/src/modules/config/routes.ts) hard-codes `bond_asset: "native"` in `GET /v1/config`.
  - [`frontend/src/lib/format.ts`](../frontend/src/lib/format.ts) (`stroopsToXlm`, `xlmToStroops`) and the dashboard forms ([`frontend/src/app/submissions/new/form.tsx`](../frontend/src/app/submissions/new/form.tsx), [`frontend/src/app/reexecutors/register/form.tsx`](../frontend/src/app/reexecutors/register/form.tsx), [`frontend/src/components/open-challenge-button.tsx`](../frontend/src/components/open-challenge-button.tsx), [`frontend/src/components/withdraw-stake.tsx`](../frontend/src/components/withdraw-stake.tsx)) assume 7-decimal native XLM everywhere.
- **What "done" means:** Allow `deployments/<name>.json` and `deploy_testnet.sh` to configure any SEP-41 token contract address (such as mainnet USDC via its Stellar Asset Contract), expose the bond asset contract ID, symbol, and decimals from `GET /v1/config`, and format/parse all dashboard bond and stake amounts using the configured asset's decimals and symbol.

---

## 4. Operations

### 4.1 Network as a deployment setting and RPC provider choice

- **Status:** `done` (script & dashboard network parameterization) / `missing` (mainnet RPC provider & production compose defaults)
- **Owner:** Operator / Infrastructure
- **Current state:**
  - **Done in code:** [`scripts/_deployment.sh`](../scripts/_deployment.sh) reads `network`, `network_passphrase`, and `rpc_url` from `deployments/<name>.json` (defaulting to testnet so [`deployments/testnet.json`](../deployments/testnet.json) continues working unchanged). [`scripts/dev.sh`](../scripts/dev.sh) and [`scripts/smoke.sh`](../scripts/smoke.sh) refuse any deployment record with `"network": "mainnet"`. [`scripts/deploy_testnet.sh`](../scripts/deploy_testnet.sh) requires `--mainnet-i-have-read-docs-MAINNET` alongside `VERITY_NETWORK=mainnet`, never calls `--fund` on mainnet, and fails if any required identity is missing or unfunded. [`frontend/src/lib/config.ts`](../frontend/src/lib/config.ts) provides `explorerUrl(kind, id, passphrase)` keyed by `/v1/config`'s `network_passphrase`, and [`frontend/src/components/fund-account-button.tsx`](../frontend/src/components/fund-account-button.tsx) and [`frontend/src/app/api/friendbot/route.ts`](../frontend/src/app/api/friendbot/route.ts) disable Friendbot outside testnet.
  - **Still missing for mainnet:** [`docker-compose.yml:12-13,98`](../docker-compose.yml), [`backend/.env.example:7-8`](../backend/.env.example), [`reexecutor-agent/src/index.ts:15-16`](../reexecutor-agent/src/index.ts), and [`docs/DEPLOY.md:126-131`](DEPLOY.md) still default to `https://soroban-testnet.stellar.org` when environment variables are omitted. SDF does not run a free public mainnet Soroban RPC equivalent to `soroban-testnet.stellar.org`, and as documented in [`docs/ARCHITECTURE.md:138-139`](ARCHITECTURE.md) and [`docs/DEPLOY.md:204-205`](DEPLOY.md), if the indexer is offline longer than the RPC's event retention window (~7 days), missed events are skipped permanently.
- **What "done" means:** Provision a dedicated or commercial mainnet Soroban RPC endpoint with an SLA, archive/history coverage, and rate limits sized for the indexer, keeper, and re-executors; require explicit `SOROBAN_RPC_URL` and `NETWORK_PASSPHRASE` in [`docker-compose.yml`](../docker-compose.yml) without testnet fallbacks.

### 4.2 Automated contract and persistent entry TTL extension job

- **Status:** `partial`
- **Owner:** Backend / Contracts
- **Current state:** [`contracts/escrow-gate/src/storage.rs:24-38`](../contracts/escrow-gate/src/storage.rs) and [`contracts/zk-verifier-registry/src/lib.rs:19-24`](../contracts/zk-verifier-registry/src/lib.rs) bump instance storage and touched persistent keys to `BUMP_TO = 500_000` ledgers (~29 days at ~5s/ledger) whenever remaining TTL drops below `BUMP_THRESHOLD = 100_000` ledgers. Any persistent entry (`DataKey::Submission(u64)`, `DataKey::Reexecutor(Address)`, `DataKey::ReplayAttestation(u64, Address)`, `DataKey::Challenge(u64)`) untouched for ~29 days is archived by Soroban. [`docs/DEPLOY.md:223-241`](DEPLOY.md) documents manual `stellar contract extend` / `restore` commands and notes that restoring individual archived `DataKey` entries requires constructing raw base64 XDR keys by hand.
- **What "done" means:** Add a scheduled background worker (or automated CLI job) that constructs the exact XDR `DataKey`s for the contract instances, all active re-executors, and any non-settled submissions, checks their `liveUntilLedgerSeq` via Soroban RPC `getLedgerEntries`, and submits `extendFootprintTTL` (and `restoreFootprint` if needed) transactions automatically well before expiry.

### 4.3 Off-host backups and shared artifact storage

- **Status:** `missing`
- **Owner:** Operator / Backend
- **Current state:** Content-addressed artifacts (inputs, function bodies, claimed outputs) live on one host's local filesystem under `ARTIFACT_STORAGE_DIR` ([`backend/src/modules/artifacts/routes.ts:15-73`](../backend/src/modules/artifacts/routes.ts), [`docker-compose.yml:84-88`](../docker-compose.yml), [`README.md:686-687`](../README.md)). Only their SHA-256 hashes are written on-chain, so lost artifacts cannot be recovered from chain history ([`docs/DEPLOY.md:204-206`](DEPLOY.md)). Backup procedures in [`docs/DEPLOY.md:183-203`](DEPLOY.md) are manual `pg_dump` and `tar` one-liners.
- **What "done" means:** Move artifact storage to durable, replicated object storage (such as S3/R2/GCS with SHA-256 integrity checks on read) and automate scheduled, encrypted, off-host Postgres and artifact backups with tested point-in-time recovery.

### 4.4 Second backend instance, worker failover, and webhook retries

- **Status:** `partial`
- **Owner:** Backend / Infrastructure
- **Current state:**
  - **Single worker instance:** Setting `RUN_WORKERS=false` ([`backend/src/config/env.ts:60-62`](../backend/src/config/env.ts), [`docs/DEPLOY.md:179-181`](DEPLOY.md)) lets additional API-only backend containers run, provided they share artifact storage. However, only one container may run `RUN_WORKERS=true`: keeper transaction sequencing uses an in-process queue (`withKeeperLock` in [`backend/src/chain/keeper.ts:19-24`](../backend/src/chain/keeper.ts)), and [`backend/src/workers/indexer.ts`](../backend/src/workers/indexer.ts) and [`backend/src/workers/scheduler.ts`](../backend/src/workers/scheduler.ts) have no cross-process leader lock.
  - **Single-attempt webhooks:** [`backend/src/modules/webhooks/dispatcher.ts:52,157-188`](../backend/src/modules/webhooks/dispatcher.ts) makes one HTTP POST attempt per event with a 5-second timeout and no retry ([`README.md:529-537`](../README.md), [`README.md:686-687`](../README.md), [`docs/DEPLOY.md:303`](DEPLOY.md)). Deliveries in flight when the backend restarts stay `pending` in `webhook_delivery`.
- **What "done" means:** Use Postgres advisory locks (or a distributed lease) around the worker loops and keeper sequence queue so a second backend instance can run in warm standby and fail over automatically; add a durable retry loop with exponential backoff for `pending` and `failed` rows in `webhook_delivery`.

---

## 5. Product

### 5.1 Open voter set versus `reexecutor_allowlist`

- **Status:** `partial`
- **Owner:** Product / Contracts / Backend
- **Current state:** `EscrowGate` enforces an admin allow-list whenever `ConfigRecord::reexecutor_allowlist` is `true` ([`contracts/escrow-gate/src/lib.rs:268-293,480-482`](../contracts/escrow-gate/src/lib.rs)). All current deployments set `reexecutor_allowlist: true` ([`scripts/deploy_testnet.sh:58-69`](../scripts/deploy_testnet.sh)) because testnet stake is free and an open voter set could be captured at no cost ([`README.md:673-675`](../README.md), [`docs/DEPLOY.md:301-302`](DEPLOY.md)). That gives the admin real power over *who* may vote (though never over a verdict directly). In addition, off-chain work assignment in [`backend/src/modules/reexecutors/assignment.ts`](../backend/src/modules/reexecutors/assignment.ts) samples online eligible re-executors uniformly ([`README.md:679-681`](../README.md)), whereas on-chain consensus in [`contracts/escrow-gate/src/lib.rs:78-108`](../contracts/escrow-gate/src/lib.rs) weights votes by total stake.
- **What "done" means:** Either explicitly launch mainnet as a permissioned validator set governed by the admin multisig (with published admission, SLA, and revocation rules), or before turning `reexecutor_allowlist` off, align assignment probability with stake weight, cap per-voter weight or require total quorum stake to exceed a multiple of `escrow_value`, and enforce an unbonding period.

---

## 6. Legal and treasury

### 6.1 Where forfeited bonds and slashed stakes go

- **Status:** `missing`
- **Owner:** Legal / Treasury / Contracts
- **Current state:** When a submission is slashed in [`settle` (`contracts/escrow-gate/src/lib.rs:140-159`)](../contracts/escrow-gate/src/lib.rs) or a wrong-side re-executor is slashed in [`apply_slash` (`contracts/escrow-gate/src/lib.rs:212-230`)](../contracts/escrow-gate/src/lib.rs), a prevailing challenger receives `cfg_slash_split_challenger_bps` (20% by default) and the remaining 80% — or 100% when there is no prevailing challenger — is transferred directly to `storage::get_admin(e)` ([`docs/DEPLOY.md:243-249`](DEPLOY.md)). There is no separate `treasury` address in `EscrowGate`, no separation between administrative authority and custody of forfeited funds, and no legal, accounting, or redistribution policy for forfeited value.
- **What "done" means:** Separate the `treasury: Address` recipient from `admin: Address` in `EscrowGate` (with its own rotation entrypoint), point it to a designated treasury multisig or burn/insurance contract backed by a defined legal entity and terms of service, and document the accounting and tax treatment of forfeited bonds and slashed stakes.
