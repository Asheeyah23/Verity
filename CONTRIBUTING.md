# Contributing to Verity

Thanks for helping. Verity is an optimistic verification layer for Soroban
escrow: bonded re-executors replay an AI agent's work, and a challenge window
and slashing sit behind the verdict. Read the [README](README.md) first for
what the system does and what it deliberately does not prove, then
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for where things live.

By contributing you agree your work is licensed under the
[Apache License 2.0](LICENSE). Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Security problems do **not** go in
public issues; see [SECURITY.md](SECURITY.md).

## Ground rules

- **Be honest about what the code proves.** Phase 1 is economically enforced
  and replay-checked, not cryptographically proven. No change may make the UI,
  API, docs or contract report a ZK-verified result, or a verdict "reached by
  consensus" when it was reached by a window elapsing. If you add a new way a
  verdict can arise, the dashboard and the API must say how.
- **The contract is the only authority on a verdict.** The backend mirrors
  chain state; it never decides, overrides or invents one.
- **No fake data.** Do not add mock rates, placeholder submissions or
  hardcoded numbers to anything a user sees. If something cannot run on real
  testnet data, say so on the screen.
- **Keys stay with their owner.** The backend builds unsigned XDR and relays
  signed XDR. It never holds a user's key.
- **Small, focused pull requests.** One concern each. Unrelated cleanups go in
  their own PR.

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 22.6+ (CI and `.nvmrc` use 22) | backend, agent, dashboard |
| pnpm | 10 | workspace |
| [stellar-cli](https://developers.stellar.org/docs/tools/cli) | current | deploying, bindings, identities |
| Rust | pinned by `contracts/rust-toolchain.toml` | contract work only |

Docker is not required. Rust is only needed if you change or test contracts;
`rustup` picks up the pinned toolchain (and the `wasm32v1-none` target,
`rustfmt` and `clippy`) automatically inside `contracts/`.

## Getting set up

```bash
git clone https://github.com/DevQwinB/Verity.git
cd Verity
pnpm install
pnpm dev          # Postgres, migrations, backend, re-executors, dashboard
```

`pnpm dev` runs against the contracts recorded in `deployments/testnet.json`
(the **dev** deployment, 10-minute challenge windows). The dashboard is on
http://localhost:3000 and the API on http://localhost:3001. The README's
"Run it" section covers ports and the first-time bootstrap
(`scripts/deploy_testnet.sh --force`, `scripts/bootstrap_reexecutors.sh`).

### Things that bite

- **The stellar-cli keystore is one flat namespace shared by every project on
  your machine.** The dev deployment uses the aliases `deployer`, `keeper` and
  `rex1`…`rex5`. If another project generates an identity under one of those
  names it replaces yours. The scripts stop if the admin or a staked
  re-executor no longer matches `deployments/testnet.json`. Use
  `VERITY_DEPLOYMENT=<name>` to work against your own deployment
  (`deployments/<name>.json`, `verity-<name>-…` aliases) instead of sharing
  the dev one.
- **After a testnet reset or a contract redeploy**, the local database still
  mirrors the old contract. Run `pnpm db:reset`, and re-stake the re-executors
  with `scripts/bootstrap_reexecutors.sh`.
- **`EscrowGate` has no upgrade entrypoint.** A contract change means a new
  deployment and a new contract ID. Do not commit a redeployed
  `deployments/testnet.json` unless the PR is specifically about the dev
  deployment.
- **Smoke submissions are real on-chain records.** `pnpm smoke` only runs
  against a local backend and refuses a deployment marked `"public": true`.
  Never point it at a deployment other people use.
- **Never commit secrets.** `backend/.env` and `.env` are gitignored. Keys
  live in your stellar-cli keystore.

## Repository map

| Path | What |
|---|---|
| `contracts/` | Soroban contracts (`escrow-gate`, `zk-verifier-registry`, `example-marketplace-escrow`, shared `common`) |
| `backend/` | Fastify API, SEP-10 auth, chain indexer, keeper/scheduler |
| `reexecutor-agent/` | Worker that replays assignments in a WASM sandbox and attests on-chain |
| `frontend/` | Next.js dashboard (Freighter wallet) |
| `db/` | Kysely schema and migrations, embedded Postgres for local dev |
| `scripts/` | Deploy, bootstrap, approve, bindings, dev runner, smoke test |
| `deployments/` | Contract IDs and public keys, one file per deployment |

## Making a change

1. **Pick or open an issue** and say you are working on it, so effort is not
   duplicated. For anything beyond a small fix, agree the approach in the
   issue first. Good starting points carry `good first issue`; size labels
   (`trivial`, `medium`, `high`) indicate the expected effort.
2. **Branch from `main`** and keep the branch to one concern.
3. **Write the change and its tests** (see below).
4. **Run the checks** that CI runs, locally (see below).
5. **Open a pull request** using the template. Link the issue
   (`Closes #123`) and describe how you verified the change.

### Checks to run before you push

```bash
pnpm test:contracts                                   # cargo test in contracts/
pnpm --filter escrow-gate --filter zk-verifier-registry build   # bindings build output, needed by typecheck
pnpm typecheck                                        # every package
pnpm --filter @verity/backend test                    # backend unit tests
pnpm --filter @verity/frontend test                   # dashboard unit tests
pnpm --filter @verity/reexecutor-agent test           # sandbox, canonical JSON, retrieval
pnpm lint                                             # frontend ESLint
pnpm --filter @verity/frontend build                  # dashboard builds
```

CI also builds the three container images. If you touched a `Dockerfile` or
the dependency set, build the affected image locally:

```bash
docker build -f backend/Dockerfile -t verity-backend .
```

For contract changes also run `cargo fmt` and `cargo clippy` inside
`contracts/`.

### Testing

- **Contracts.** Unit tests live in `contracts/*/src/test.rs`.
  `contracts/escrow-gate/src/test/proptest_model.rs` is a property-based model
  of the consensus outcome. A contract change needs a test, and a change to
  verdict, bond or slashing logic needs to keep the invariants listed in
  [PRD §8](docs/PRD.md) holding. Run `cargo test` in
  `contracts/` (or `pnpm test:contracts`).
- **End to end.** `pnpm smoke` (with `pnpm dev` running in another terminal)
  drives honest and dishonest work, challenges, and a wrong-voting
  re-executor against the live stack and real testnet. Run it for any change
  to the backend, the agent or the contract flow, and say so in your PR.
  `SMOKE_SLOW=1 pnpm smoke` and
  `SMOKE_PROFILE=underquorum pnpm smoke` (with `VERITY_REEXECUTORS="rex1 rex2"`)
  wait out real challenge windows; run them for changes that touch
  finalisation, expiry or assignment.
- **TypeScript unit tests** live next to the code as `*.test.ts` (backend,
  re-executor agent) and `*.test.mjs` (dashboard) and run with
  `pnpm --filter <package> test`. New pure logic should come with a test.

### Changing a contract interface

1. Edit the contract and its tests.
2. Regenerate the TypeScript bindings:
   `scripts/generate_bindings.sh` (builds the wasm, writes
   `backend/src/chain/generated/`). Commit the result.
3. Refresh the interface snapshots in `deployments/interfaces/` with
   `scripts/export_interfaces.sh` (it needs the release wasm: run
   `cargo build --release --target wasm32v1-none` in `contracts/` first) if
   the PR changes a public entrypoint.
4. Redeploy to your own deployment to try it
   (`VERITY_DEPLOYMENT=<name> scripts/deploy_testnet.sh --force`). Do not
   overwrite the shared dev deployment in a PR unless asked to.

### Changing the database

Add a new numbered migration under `db/migrations/` (never edit an applied
one), update `db/src/types.ts`, and run `pnpm db:migrate`.

### Canonical JSON must stay identical

Outputs are hashed as canonical JSON (keys sorted, no whitespace). The same
function exists in three places and they **must** behave identically, or
honest work will produce false mismatches:

- `reexecutor-agent/src/sandbox/canonical.ts`
- `frontend/src/lib/canonical.ts`
- `backend/src/chain/canonical.ts`

Change one, change all three, and add a case that exercises it.

## Style

- Match the surrounding code: naming, comment density and idiom.
- Comments explain *why* (constraints, past bugs, protocol facts), not what the
  next line does. Several files carry notes about bugs that were fixed. Keep
  them accurate when you change the code they describe.
- TypeScript is strict; no `any` to get past the compiler.
- Rust: `cargo fmt`, no new `clippy` warnings. Contract errors go in
  `contracts/common/src/errors.rs`. Add a variant rather than reusing one.
- Commit messages: a short imperative subject (about 50 characters), with a
  body only when the reason isn't obvious.
  Examples from this repo: "Guard against another project replacing a
  keystore identity", "Only record an assignment as missed when it had time to
  answer".
- Docs changes that ship with a behaviour change belong in the same PR. If you
  change a limit, a default, an endpoint or a verdict path, update the README
  (including "Known limits") and `docs/ARCHITECTURE.md` in that PR.

## Review

A maintainer reviews every PR. Expect questions about the failure modes: what
happens if the RPC drops, if the indexer replays an event, if two keeper
transactions race, if a re-executor is offline. A PR is ready to merge when CI
is green, the issue is addressed, the scope is focused, and the verification
you describe matches what you actually ran.

Thank you for contributing.
