# Architecture

A map of the code for contributors. The README says what Verity does and what
it does not prove; [`docs/PRD.md`](PRD.md)
is the product document. This file says where each responsibility lives and
which rules you must not break when you touch it.

## One principle

**The contract is the source of truth; everything else mirrors it.** The
backend database is a cache of chain state plus the off-chain data the chain
does not hold (artifacts, assignments, webhooks). If the two disagree, the
chain wins, and the backend should reconcile to it.

## Components

```
                       ┌────────────────────────────────────────────┐
 Freighter wallet ───▶ │ frontend (Next.js)                         │
 (user signs)          │   proxies to the backend, never signs      │
                       └──────────────┬─────────────────────────────┘
                                      │ HTTP + SEP-10 JWT
                       ┌──────────────▼─────────────────────────────┐
                       │ backend (Fastify)                          │
                       │   routes: build unsigned XDR / relay signed│
                       │   indexer  ── reads contract events ───────┼──▶ Soroban RPC
                       │   scheduler ─ keeper-signed finalize,      │       │
                       │               resolve, release lock        │       ▼
                       │   Postgres (Kysely) = mirror of chain      │   EscrowGate
                       └──────────────▲─────────────────────────────┘   ZKVerifierRegistry
                                      │ poll assignments, fetch artifacts
                       ┌──────────────┴─────────────────────────────┐
                       │ reexecutor-agent (one per staked account)  │
                       │   replay in WASM sandbox, hash canonically │
                       │   attest_replay() signed with its own key ─┼──▶ Soroban RPC
                       └────────────────────────────────────────────┘
```

### Contracts (`contracts/`)

| Crate | Role |
|---|---|
| `common` | Shared types (`SubmissionRecord`, `ConfigRecord`, `Verdict`, `Resolution`, `ResolutionMethod`, `TaskType`, …) and the single `Error` enum. |
| `escrow-gate` | The core. Holds bonds and stakes, records submissions, replay votes and challenges, and computes verdicts. Entrypoints: `submit`, `register_reexecutor`, `withdraw_stake`, `attest_replay`, `release_attestation_lock`, `open_challenge`, `resolve_challenge`, `finalize`, `slash`, admin `update_config` / `set_reexecutor_approved`, and getters. |
| `zk-verifier-registry` | Deployed **empty** as the Phase 2 anchor. `escrow-gate` rejects the ZK resolution method outright, so nothing can report a ZK-verified result. |
| `example-marketplace-escrow` | Reference integration only. Not deployed. |

Rules that hold in the contract and must keep holding (PRD §8; the proptest
model in `escrow-gate/src/test/proptest_model.rs` covers consensus):

1. No auto-verify before the challenge window closes, unless a bonded
   `Verified` majority of replays already exists.
2. A slash only follows a provable mismatch, never admin discretion. The slash
   amount is a fixed on-chain share of stake, applied when the stake lock is
   released, so it cannot be chosen by the caller or escaped by withdrawing.
3. `finalize()` is idempotent and irreversible.
4. `verify_proof` has no default-accept path.
5. Bonds are proportional to escrow value and snapshotted at `submit()` time.

The config in force at `submit()` is snapshotted on the submission
(`cfg_*` fields), so later `update_config` calls never change a submission
already in flight.

### Backend (`backend/src/`)

| Path | Responsibility |
|---|---|
| `app.ts`, `index.ts` | Fastify app and process entry. `RUN_WORKERS=false` starts an API-only instance. |
| `auth/` | SEP-10 challenge and verify, JWT plugin. |
| `config/` | Environment parsing and network setup. |
| `chain/` | The only code that talks to Soroban. `clients.ts` (generated-binding clients), `rpc.ts`, `actions.ts` (read a submission, finalize, resolve, release lock, contract-error naming), `keeper.ts`, `mappers.ts` (chain enums ↔ DB enums), `canonical.ts`, `config.ts`. |
| `workers/indexer.ts` | Polls `getEvents` from a cursor stored in `chain_cursor`, mirrors submissions, votes, challenges and verdicts into Postgres, triggers assignment, and finalises early when a bonded consensus exists. |
| `workers/scheduler.ts` | Periodic sweep: finalise submissions whose window elapsed, resolve challenges, settle (release attestation locks so wrong-side voters are slashed), export attestations, top up assignments. |
| `modules/submissions/` | Build `submit()`, relay, list/get, `verdict.ts` (**the single writer** of a terminal verdict). |
| `modules/reexecutors/` | Register/withdraw/sync, `assignment.ts` (deterministic, auditable selection), the work queue that agents poll. |
| `modules/challenges/` | Build `open_challenge()`, relay, list. |
| `modules/artifacts/` | Content-addressed upload and fetch. |
| `modules/attestations/` | Signed attestation payload for a settled verdict. |
| `modules/webhooks/` | HMAC-signed delivery plus `url-guard.ts`, which refuses private addresses. |
| `modules/{config,taxonomy,reports,marketplaces}/` | Live rules, task taxonomy, verification-rate report, marketplace and webhook registration. |
| `chain/generated/` | TypeScript bindings generated from the contracts. Do not edit by hand; run `scripts/generate_bindings.sh`. |

#### Build, sign, relay

Every state-changing user call has three steps:

1. `POST /v1/...` builds an **unsigned** transaction for that user's account.
2. The wallet signs it.
3. `POST /v1/.../relay` forwards it. A relay endpoint only forwards the
   EscrowGate call it was built for and refuses any other transaction.

The backend signs only with the **keeper** key, for `finalize`,
`resolve_challenge` and `release_attestation_lock`. The keeper holds no
authority over verdicts: those calls are permissionless on-chain, and the
contract re-derives the outcome itself. `chain/actions.ts` has a local copy of
the consensus arithmetic, used only to decide whether sending a transaction is
worthwhile.

All keeper transactions share one account sequence number, and the indexer
and scheduler run concurrently. Every keeper send goes through
`withKeeperLock` in `chain/keeper.ts`; bypass it and you will see `txBadSeq`.

#### Terminal verdicts

`modules/submissions/verdict.ts` is the one place a submission moves into
`verified`, `slashed` or `expired_unverified`. It is called from every place a
verdict can first be seen (the `Finalized` event, the keeper's own calls, the
reconcile pass), is safe to call repeatedly, and fires the webhook only on the
call that causes the transition. It reads *how* the verdict was reached back
from the contract (`resolution_method`) instead of assuming it. Keep it that
way: a window that elapsed without consensus must never be recorded as
consensus.

#### Decoding gotcha

A fieldless `#[contracttype]` enum decodes as `{ tag: "Verified" }` through the
generated client but as `["Verified"]` through `scValToNative` on a raw event.
`chain/mappers.ts` accepts both. Handling only one shape previously reverted
finalised submissions to `pending`. Reuse the mappers; do not hand-roll a new
decode.

#### Indexer guarantees and gaps

The indexer (`backend/src/workers/indexer.ts`) mirrors on-chain contract events into Postgres. It provides several core guarantees alongside known operational gaps:

**Guarantees:**
- **Non-overlapping polling and per-event cursor persistence:** `startIndexer(intervalMs = 4000)` polls every 4000 ms in non-overlapping ticks, requesting pages of `PAGE_SIZE = 100` events from `getEvents`. The cursor (`chain_cursor`, keyed by `ESCROW_GATE_CONTRACT_ID`) is persisted after every processed event. If a failure occurs mid-page, the next poll resumes immediately after the last successfully processed event.
- **Idempotent event handlers:** `handleEvent` handlers upsert records against unique keys derived from on-chain identity (`chain_submission_id`, `(submission, reexecutor)` pairs, etc.). Replaying an event after a crash or restart never duplicates database rows.
- **Contract is authoritative (chain wins):** The indexer never invents or overrides verdicts. All terminal state transitions route through `recordTerminalVerdict`, which verifies the contract's reported `resolution_method`.

**Operational gaps & consequences:**
- **100-ledger lookback on first start:** When starting on a fresh database with no stored cursor, `getCursor` begins at `Math.max(latest.sequence - 100, 1)` (roughly 100 ledgers or ~8 minutes).
  *Consequence:* Any events emitted more than ~100 ledgers before the database was initialized are never indexed; earlier history is not shown.
- **Direct on-chain submissions without a draft are ignored:** When processing `submission_created`, the indexer matches by `chain_submission_id` or the draft's `chain_tx_hash`. If no matching draft exists in the database, the event is ignored because there are no off-chain artifacts to fetch or replay. Similarly, drafts purged after `DRAFT_TTL_S` (3600 s) by `purgeDraftsOnce` will be ignored if their transaction confirms late.
  *Consequence:* Submissions submitted directly on-chain without using the backend API are intentionally untracked.
- **Events with missing parent rows are dropped:** Events such as `replay_attested`, `challenge_opened`, `challenge_resolved`, `finalized`, and `slashed` require their corresponding parent submission or re-executor rows to exist in Postgres; if absent, the event is dropped.
  *Consequence:* If a parent record is not in the database, subsequent child events cannot be linked or backfilled through normal polling.
- **Cursor reset after falling behind RPC retention:** If the indexer is offline longer than the RPC event retention window (~7 days), `getEvents` throws. `pollOnce` detects that `cursor.ledger < health.oldestLedger` and jumps the cursor forward to `Math.min(Math.max(cursor.ledger, health.oldestLedger + 10), health.latestLedger)`.
  *Consequence:* Events occurring between the old cursor and the new retention boundary are permanently skipped and never read by the indexer.
- **Five-failure give-up rule:** If processing a specific event throws an unhandled error across `MAX_EVENT_RETRIES = 5` consecutive attempts, the indexer logs an error, drops the event, and advances the cursor.
  *Consequence:* A permanently corrupt or unprocessable event will not wedge the indexer loop forever, but that specific event's database state is skipped.
- **Limited repair scope of `reconcileOnce`:** Every 10 seconds, `reconcileOnce` (`backend/src/workers/scheduler.ts`) checks tracked submissions in `pending` or `disputed` state and updates them if the on-chain contract is already finalised.
  *Consequence:* A dashboard row stuck `pending` while the chain is finalised will be repaired on the next reconcile pass, but `reconcileOnce` does not backfill votes, challenges, slashes, or untracked submissions.
- **Settlement grace period for missing votes:** When a submission is settled, `settleOnce` waits up to `SETTLE_GRACE_S = 600` seconds for all on-chain votes to be indexed. Once this grace period expires, it settles with whatever votes have been recorded.
  *Consequence:* A missing vote row can leave an attestation listing fewer votes than the contract actually holds on-chain; unindexed voter locks must be released manually via `release_attestation_lock()`.

### Re-executor agent (`reexecutor-agent/src/`)

Each agent holds one staked account's secret key and loops:

1. Log in over SEP-10, poll `GET /v1/reexecutors/:id/assignments`. Polling is
   what marks the worker online; only online workers are assigned.
2. Fetch the declared artifacts by content hash.
3. **Deterministic tasks:** `sandbox/runner.ts` runs the function in
   fuel-instrumented `quickjs-emscripten` (WebAssembly) inside a worker thread
   with fixed memory, stack and WebAssembly fuel limits, no clock and no
   randomness. Exceeding a limit — in bytecode or native builtins — is a
   mismatch, identically on every host.
4. **Retrieval tasks:** `sandbox/retrieval.ts` re-fetches the declared URL
   with a private-address guard, retrying for a bounded time before concluding
   the target is at fault.
5. Hash the output as canonical JSON, then call `attest_replay(matched)` on
   `EscrowGate`, signed with the agent's own key.

The most important rule: **an agent never votes on its own host's failures.**
`ReplayInfrastructureError`, a failed connectivity check or a wall-clock kill
say nothing about the submission, so they are retried, never turned into a
vote. A false mismatch slashes an honest agent.

### Database (`db/`)

Kysely schema and numbered migrations (`db/migrations/`), typed in
`db/src/types.ts`. `local-postgres.ts` runs an embedded Postgres for
Docker-free dev under `.pgdata/`. Tables: `marketplace`, `submission`,
`submission_artifact`, `reexecutor`, `replay`, `spot_check`, `challenge`,
`zk_proof`, `attestation_export`, `slashing_event`, `webhook_subscription`,
`webhook_delivery`, `chain_cursor`.
`replay.assignment_seed` stores the seed so anyone can reproduce an
assignment.

### Frontend (`frontend/`)

Next.js app. It proxies API calls through its own route handlers, connects
Freighter, and signs in with SEP-10. It only renders what the API reports.
Verdict badges distinguish *how* a verdict was reached ("Verified by default"
versus consensus), and that distinction must survive any UI change.

## Lifecycle of a submission

```
submit() + agent bond ──▶ SubmissionCreated event ──▶ indexer mirrors it,
                                                        assigns live re-executors
        │
        ├─ deterministic ─ quorum (+1 spare) replays ─ attest_replay(matched) × N
        │        bonded supermajority? ── yes ──▶ finalize early
        │                                  no  ──▶ wait for the window
        │
        ├─ retrieval ──── one sampled spot-check
        │        match    → left to default when the window closes
        │        mismatch → escalate this and the agent's other pending
        │                   submissions to a full quorum
        │
        └─ anyone but the agent ─ open_challenge() + bond (while the window is open)
                         → resolve_challenge() by re-execution consensus
                           (the ZK method is rejected in Phase 1)

window elapsed ──▶ finalize() ──▶ one of:
    verified            (consensus)        agent bond returned
    verified            (window elapsed)   "verified by default", not replayed to quorum
    slashed             (consensus)        agent bond forfeited
    expired_unverified  (window elapsed)   nothing established; all bonds returned

then: release_attestation_lock() per voter ──▶ wrong-side voters slashed,
      stake unlocked ──▶ signed attestation exported, webhook fired
```

Database `submission.status`: `pending`, `verified`, `disputed`, `slashed`,
`expired_unverified`. `replay.status`: `assigned`, `submitted`,
`confirmed_onchain`, `missed`. An assignment is only marked `missed` when the
re-executor had time to answer.

## Deployments and scripts

`deployments/<name>.json` holds contract IDs and public keys for one
deployment. `VERITY_DEPLOYMENT` selects it in every script; `testnet` is the
shared dev deployment (10-minute windows), and a `--public` deployment is
for other people (real windows) and is refused by `pnpm dev` and `pnpm smoke`.
`scripts/_deployment.sh` holds the shared logic, including the check that the
stellar-cli keystore still matches the recorded admin and re-executors.

| Script | Purpose |
|---|---|
| `deploy_testnet.sh` | Build, deploy and configure the contracts; write the deployment file. |
| `bootstrap_reexecutors.sh` | Stake and approve the bootstrap re-executors. |
| `approve_reexecutor.sh` | Admin approval of one staked account. |
| `generate_bindings.sh` | Rebuild the TypeScript bindings. |
| `export_interfaces.sh` | Export contract interface JSON to `deployments/interfaces/`. |
| `dev.sh` | The whole stack locally. |
| `smoke.sh` | End-to-end check against the local stack and real testnet. |

## Known limits that affect design

These are stated in the README; they shape what is safe to change.

- One backend instance runs the indexer and keeper. Do not add a second with
  workers on.
- Artifacts live on the backend's local disk.
- Webhooks are delivered once with no retry.
- Assignment is uniform, not stake-weighted, and only picks online workers.
- Only `deterministic` and `retrieval` tasks are accepted. `submit()` rejects
  `unverifiable` with `InvalidTaskType`: Phase 1 has no verification path for
  open-ended or subjective work.
- Contracts are unaudited and testnet-only.
