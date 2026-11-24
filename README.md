# Verity

An optimistic verification layer for Soroban escrow. A marketplace's escrow
contract asks Verity's `EscrowGate` for a verdict before it pays an AI agent;
the verdict comes from bonded re-executors replaying the agent's work, with a
challenge window and slashing behind it.

**What is and is not proven.** Phase 1 (this repo) is *economically enforced
and replay-checked*. It is not cryptographic proof of model correctness.
`EscrowGate` accepts no ZK proofs: its challenge resolution rejects the ZK
method outright, so no code path can report a ZK-verified result. The
`ZKVerifierRegistry` contract is deployed empty as the anchor for Phase 2. See
[`docs/PRD.md`](docs/PRD.md) for the full scope.

## How a submission is verified

```
agent ── submit() + bond ──▶ EscrowGate (Soroban, testnet)
                                 │ SubmissionCreated event
                                 ▼
                    backend indexer ── assigns online re-executors
                                 │
        re-executor agents ◀─────┘  fetch the declared artifacts, re-derive the
                 │                  output, hash it canonically
                 └── attest_replay(matched) ──▶ EscrowGate (bonded vote)
                                                   │
backend keeper ── finalize() / resolve_challenge() ┘  verdict + bond settlement
               └─ release_attestation_lock()  slashes a wrong-side voter, then
                                              unlocks the stake
```

| Task type | How it is checked |
|---|---|
| `deterministic` | A quorum (plus one spare) replays the declared function over the declared input in a WebAssembly sandbox and votes match/mismatch. A bonded supermajority finalizes immediately. |
| `retrieval` | One sampled re-executor re-fetches the declared URL (spot-check). A match leaves the submission to be verified by default when its challenge window closes; a mismatch escalates it — and the agent's other pending submissions — to a full quorum. |

Every verdict records how it was reached, and the dashboard shows it:

| Verdict | Reached by | Meaning |
|---|---|---|
| `verified` | re-execution consensus | A bonded supermajority replayed the work and it matched. Agent bond returned. |
| `verified` | window elapsed | Nobody challenged and no quorum formed. **Not replayed to quorum**; shown as "Verified by default". Agent bond returned. |
| `slashed` | re-execution consensus | A bonded supermajority found a mismatch. Agent bond forfeited. |
| `expired_unverified` | window elapsed | Either a challenge that no quorum could resolve, or a window that closed with a mismatch reported but no quorum. Nothing was established; every bond is returned and nobody is slashed. |

Anyone can open a bonded challenge inside the window. If the challenge is
upheld, the challenger gets their bond back plus 20% of the agent's, and the
rest of the agent's bond goes to the admin/treasury account. If it is rejected,
the challenger's bond goes to the agent.

A re-executor whose vote a bonded consensus proves wrong loses a fixed share
of its stake (10% as deployed). The amount is set on-chain and applied when
its stake lock is released, so it can be neither chosen by the caller nor
escaped by withdrawing first. A verdict that only defaulted proves nobody
wrong and slashes nobody.

Outputs are hashed as **canonical JSON** (keys sorted, no whitespace), so key
order and formatting never cause a false mismatch. The same function lives in
`reexecutor-agent/src/sandbox/canonical.ts`, `frontend/src/lib/canonical.ts`
and `backend/src/chain/canonical.ts`.

## Repository layout

| Path | What |
|---|---|
| `contracts/` | Soroban contracts: `escrow-gate`, `zk-verifier-registry`, `example-marketplace-escrow` (reference only, not deployed), shared `common` types |
| `backend/` | Fastify API, SEP-10 auth, chain indexer, keeper/scheduler |
| `reexecutor-agent/` | Worker that replays assignments and attests on-chain with its own key |
| `frontend/` | Next.js dashboard (Freighter wallet) |
| `db/` | Kysely schema, migrations, embedded Postgres for Docker-free dev |
| `deployments/<name>.json` | Deployed contract IDs and public keys, one file per deployment |
| `scripts/` | Deploy, bootstrap, approve, bindings, dev runner, smoke test |
| `docs/DEPLOY.md` | Running a public deployment from the container images |

## Run it

Requirements: Node 20+, pnpm 10, [stellar-cli](https://developers.stellar.org/docs/tools/cli).
Docker is not needed. Rust is needed to deploy contracts (the deploy script
builds them) and to change or test them, but not to run against a deployment
that already exists.

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts Postgres, runs migrations, and starts the backend, one
re-executor agent per bootstrap identity, and the dashboard, all against the
contracts recorded in `deployments/testnet.json`. Ctrl+C stops everything.

- Dashboard: http://localhost:3000
- API: http://localhost:3001

Ports are configurable when those are taken:

```bash
VERITY_API_PORT=4001 VERITY_WEB_PORT=4000 pnpm dev
```

The re-executor agents sign with stellar-cli identities `rex1`…`rex5`
(override with `VERITY_REEXECUTORS="alias1 alias2 alias3"`). On a fresh
machine, or after a testnet reset, create the deployment first:

```bash
scripts/deploy_testnet.sh --force   # deploys contracts, writes deployments/testnet.json
scripts/bootstrap_reexecutors.sh    # stakes rex1..rex5 and approves them as voters
pnpm db:reset                       # the local database still mirrors the old contract
```

`deployments/testnet.json` is the **dev** deployment: 10-minute challenge
windows, used by `pnpm dev` and `pnpm smoke`. A deployment for other people is
separate, with its own contracts and keys — see [`docs/DEPLOY.md`](docs/DEPLOY.md).
`VERITY_DEPLOYMENT=<name>` selects `deployments/<name>.json` in every script.

The stellar-cli keystore is one flat namespace shared by every project on your
machine. The dev deployment uses the short aliases `deployer`, `keeper` and
`rex1`…`rex5`; if another project generates an identity under one of those
names, it replaces yours. The scripts compare the keystore with
`deployments/testnet.json` and stop if the admin or a staked re-executor is no
longer the recorded account (a replaced keeper is only reported: it holds no
authority on-chain). Named deployments use `verity-<name>-…` aliases.

Secrets stay in your stellar-cli keystore. `pnpm dev` reads them at start-up
and passes them to each process through its environment. The only secrets it
writes to disk are in `backend/.env` (gitignored), and only if that file does
not exist; it also creates the local database under `.pgdata/`.

### Prove it works end to end

With `pnpm dev` running, in another terminal:

```bash
pnpm smoke                       # VERITY_API_PORT=4001 pnpm smoke if you changed it
```

This plays an agent, a challenger and one rogue re-executor against the live
stack and real testnet. It checks honest and dishonest deterministic work, a
challenged submission, that a relay endpoint refuses a transaction it was not
built for, honest and dishonest retrieval work, and that a re-executor who
votes wrong is slashed exactly the on-chain rate and can then withdraw. For
every verdict it checks how the contract says it was reached and verifies the
signed attestation. It never attests on a fleet re-executor's behalf — the
running agents do that.

Two slower modes wait out real challenge windows:

```bash
SMOKE_SLOW=1 pnpm smoke          # also: a spot-checked retrieval verifies by default

# with fewer than a quorum online, so no consensus can form:
VERITY_REEXECUTORS="rex1 rex2" pnpm dev
SMOKE_PROFILE=underquorum pnpm smoke
```

The second proves the no-quorum paths: honest work verifies by default (and is
labelled as not replayed), contested work expires unverified, an unresolved
challenge expires with both bonds returned, and nobody is slashed in any of
them.

Smoke submissions are real on-chain records. The script only runs against a
local backend, and refuses a deployment marked public.

### Use the dashboard

Install [Freighter](https://www.freighter.app/), switch it to Testnet, connect,
and use "Fund my testnet account" on the home page. Then:

- **Submissions → New** to submit work. A deterministic example:
  input `{"n": 21}`, function body `return { doubled: input.n * 2 };`,
  claimed output `{"doubled": 42}`. Change the claimed output to anything else
  to watch the bond get slashed.
- **Re-executors → Register** to stake (the on-chain floor is 500 XLM). The
  account then shows as pending until the deployment admin approves it:
  `scripts/approve_reexecutor.sh G...`. Run your own worker with
  `REEXECUTOR_SECRET_KEY=S... ESCROW_GATE_CONTRACT_ID=C... pnpm --filter @verity/reexecutor-agent start`
  (see `reexecutor-agent/.env.example`); work is only assigned to accounts
  whose worker is polling.
- Open a pending submission to challenge it while its window is open.
- A re-executor can withdraw stake from its own page, but not while any of its
  votes sits on a submission that has not settled.

## Writing replayable work

Work submitted to Verity must be deterministic: honest re-executors independently
reproduce the output and vote on whether it matches the claimed output hash.
Depending on the task type, replay runs either in a sandboxed WebAssembly JavaScript
runtime or as a guarded HTTP retrieval spot-check.

### Deterministic tasks

Deterministic tasks run in a sandboxed JavaScript runtime:

1. **Function body shape.** The function source must be a JavaScript function body,
   not an entire module or function declaration. It runs as `(function(input){ ... })(__input)`.
   To return an answer, use `return`.
2. **Arguments and global scope.** The input artifact is parsed as JSON and passed as
   the `input` argument. It is also available as the global `__input`.
3. **Sandbox engine.** QuickJS compiled to WebAssembly (`quickjs-emscripten`),
   executed in an isolated worker thread with an empty environment (`env: {}`) and
   a fresh runtime instance per replay.
4. **Environment and globals.** `Date` and `Math.random` are explicitly deleted
   before execution, so calling `new Date()` or `Math.random()` throws. Other `Math`
   functions remain available. Standard platform globals such as `console`,
   `setTimeout`, `fetch`, `process`, and `require` are absent (`typeof` each is
   `"undefined"`).
5. **Execution limits.**
   - Memory: 64 MiB (`64 * 1024 * 1024` bytes).
   - Stack: 128 KiB (`128 * 1024` bytes).
   - Computation: 1000 interrupt checks (ticks). This provides a computation budget
     of a few seconds of busy loops; loops that exceed this fail with `computation budget exceeded`.
   - Output size: serialized output can be at most 1,000,000 bytes.
   - Wall-clock timeout: 20 s host kill switch. This is a host-level safety timeout
     rather than an engine limit; if triggered, the re-executor considers its host
     overloaded, casts no vote, and retries later (`ReplayInfrastructureError`). It does
     not count as a mismatch against the submission.
6. **Failure handling.** If the function throws an exception or exceeds an engine limit
   (memory, stack, computation budget, or output size), the re-executor produces a
   32-zero-byte output hash, which never matches a legitimate claimed output hash and
   results in a mismatch vote.
7. **Return values and JSON serialization.** The return value is serialized via `JSON.stringify`:
   - A function that returns nothing (`undefined`) yields `null`.
   - `NaN` and `Infinity` serialize to `null`.
   - Object properties with `undefined` values are omitted.
   - Returning a `BigInt` throws an error and counts as a mismatch.
   - Async functions returning a `Promise` serialize to `{}`. Write synchronous code.
8. **Artifact upload limits.** Each artifact (function, input, claimed output) may be
   at most 262144 bytes (`ARTIFACT_MAX_BYTES`). The API request body limit is 1 MiB.
   Each account may upload 30 artifacts per minute (`ARTIFACT_UPLOADS_PER_MINUTE`),
   and the store holds at most 10 GiB (`ARTIFACT_MAX_TOTAL_BYTES`); uploading new
   content past that returns HTTP 507. Content already stored never counts again.
   Artifacts are **public**: `GET /v1/artifacts/:hash` needs no token, because
   anyone must be able to fetch what a verdict was computed from. Do not upload
   secrets.

### Canonical JSON and claimed outputs

9. **Hashing format.** Outputs are hashed as canonical JSON: object keys sorted
   recursively, no whitespace, `undefined`-valued object properties omitted, and
   hashed with SHA-256.
10. **Dashboard input formatting.** The dashboard "Claimed output" field parses input
    as JSON if valid; otherwise, trimmed text is treated as a JSON string and canonicalized.
    Formatting whitespace does not affect the hash: `{"doubled": 42}` and `{ "doubled":42 }`
    produce identical hashes. Numeric formatting follows `JSON.stringify` (e.g. `1.0` is `1`).
11. **Worked example.**
    - Input artifact: `{"n": 21}`
    - Function body: `return { doubled: input.n * 2 };`
    - Claimed output: `{"doubled": 42}`
    - Verification locally (from `reexecutor-agent/`):
      ```bash
      pnpm exec tsx -e '(async () => { const { runDeterministicFunction } = await import("./src/sandbox/runner.ts"); console.log(await runDeterministicFunction("return { doubled: input.n * 2 };", { n: 21 })); process.exit(0); })()'
      ```
      This evaluates the function and outputs `output: { doubled: 42 }` along with its
      canonical `outputHash`.

### Retrieval tasks

12. **Spec format.** The input artifact must be JSON conforming to `{"url": "...", "pointer"?: "/..."}`.
    Invalid JSON or a missing string `url` counts as a mismatch.
13. **HTTP request rules.** The re-executor issues a single `GET` request with
    `accept: application/json, text/plain;q=0.9, */*;q=0.1` and no credentials, auth headers,
    or cookies. The endpoint must be publicly accessible without authentication.
    Only `http:` and `https:` schemes are supported. The URL must resolve to a public IP
    address: loopback, private, and link-local IP addresses are rejected, and the request
    connects directly to the validated IP.
14. **Redirects and response codes.** Redirects are not followed; HTTP 3xx status codes
    are treated as a mismatch. Definitive 4xx statuses (for example 404 or 410) and other
    non-2xx responses are also mismatches. Statuses 401, 403, 408, 429, 451 and anything
    from 500 up, DNS failures, timeouts, and network errors are treated as transient: the worker retries for up to `min(RETRIEVAL_RETRY_BUDGET_S, challenge window / 2)`
    seconds (default `RETRIEVAL_RETRY_BUDGET_S` is 120 s), verifies its own network
    connectivity, and only votes mismatch if its own connectivity is intact. Each HTTP request
    times out after 10 s of silence or 30 s overall, and response bodies are capped at 1,000,000 bytes.
15. **JSON pointers.** If the response body is JSON, an optional RFC 6901 pointer (e.g. `/data/0/price`)
    selects the targeted value (`~1` escapes `/`, `~0` escapes `~`). The pointer must start
    with `/`; an empty pointer `""` selects the entire document. A pointer that fails to resolve
    or is specified on non-JSON content is a mismatch. If no pointer is specified, the full parsed
    JSON body is used; if the body is not JSON, the raw response text string is used.
16. **Text whitespace caveat.** The dashboard trims plain-text claimed output, whereas a
    re-executor checks the raw untrimmed response body when no pointer is specified. An endpoint
    returning text ending with a newline will not match trimmed text; prefer JSON responses
    with a JSON pointer. In addition, endpoints whose content changes between the submission
    and re-execution will produce a mismatch.

## Contracts

```bash
pnpm test:contracts                # cargo test in contracts/
```

`EscrowGate` has no upgrade entrypoint: a contract change means a new
deployment (`scripts/deploy_testnet.sh --force`), a new contract ID in
`deployments/<name>.json`, and re-staking re-executors. Each contract is
configured by its constructor in the same transaction that deploys it. If the
interface changes, regenerate the TypeScript bindings under
`backend/src/chain/generated/` with `scripts/generate_bindings.sh`.

The admin (the deploying account) can change the configuration future
submissions use, and decides which staked accounts may vote while
`reexecutor_allowlist` is on. It cannot set, change or override a verdict.

## API

SEP-10 JWT auth (`GET /auth?account=G…`, sign, `POST /auth`). Every
state-changing call is build → sign → relay: the backend returns unsigned
XDR, the caller signs with their own key, and posts it back. The backend
never holds a user's key, and a relay endpoint forwards only the EscrowGate
call it was built for.

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /auth?account=G…` | — | SEP-10 challenge: `{ transaction, network_passphrase }` |
| `POST /auth` | — | signed challenge in, `{ token }` out (400 `{ error }` on failure) |
| `GET /health`, `/health/live` | — | readiness (DB, RPC, indexer) / liveness |
| `GET /v1/config` | — | the contract's live rules |
| `POST /v1/artifacts` | Bearer | upload a content-addressed artifact |
| `GET /v1/artifacts/:hash` | — | public by design; 400 for a malformed hash, 404 if unknown |
| `POST /v1/submissions` | Bearer | build `submit()` → unsigned XDR (idempotent, see below) |
| `POST /v1/submissions/:id/relay` | Bearer | relay the signed XDR (403 unless you are the submitting agent) |
| `GET /v1/submissions[/:id]` | — | status, replays, spot-checks, challenge |
| `GET /v1/submissions/:id/attestation` | — | signed record of a settled verdict |
| `POST /v1/submissions/:id/challenge` | Bearer | build `open_challenge()` → unsigned XDR |
| `POST /v1/submissions/:id/challenge/relay` | Bearer | |
| `GET /v1/submissions/:id/proof` | — | always "not available" in Phase 1 |
| `POST /v1/reexecutors` | Bearer | build `register_reexecutor()` → unsigned XDR |
| `POST /v1/reexecutors/:id/withdraw` | Bearer | build `withdraw_stake()` → unsigned XDR (403 unless yours) |
| `POST /v1/reexecutors/:id/relay` | Bearer | relay a signed stake or withdrawal (403 unless yours) |
| `POST /v1/reexecutors/:id/heartbeat` | Bearer | marks a worker online without fetching work (204; 403 unless yours) |
| `POST /v1/reexecutors/sync` | Bearer | mirror existing on-chain stake |
| `GET /v1/reexecutors[/:id]` | — | stake, standing, record |
| `GET /v1/reexecutors/:id/assignments` | Bearer | work queue (403 for another account's id) |
| `GET /v1/challenges` | — | |
| `GET /v1/taxonomy` | — | |
| `GET /v1/reports/verification-rates` | — | |
| `POST /v1/marketplaces` | Bearer | |
| `POST /v1/marketplaces/:id/webhooks` | Bearer | 400 for an unknown event name; 403 for another account's marketplace |
| `GET /v1/marketplaces/:id/webhooks` | Bearer | your subscriptions, without `secret`; 403 for another account's marketplace |
| `PATCH /v1/marketplaces/:id/webhooks/:webhookId` | Bearer | `{"active": boolean}`; 403 for another account's marketplace, 404 for an unknown webhook |

### Authentication and token lifetime

`GET /auth?account=G…` returns a SEP-10 challenge transaction (valid for
300 seconds) plus `network_passphrase`; sign it and `POST /auth` with
`{ transaction }` to get `{ token }`. Send `Authorization: Bearer <token>`
on the routes marked above. The JWT lasts **1 hour** and carries the account
as `sub`; a missing header is 401 `{ "error": "missing bearer token" }` and a
bad or expired token 401 `{ "error": "invalid or expired token" }`.
`GET /.well-known/stellar.toml` advertises the auth endpoint and signing key.

Only `GET /auth` and `POST /v1/submissions` return `network_passphrase`.
The other build endpoints do not: `POST /v1/submissions/:id/challenge`
returns 201 `{ unsigned_transaction_xdr }` alone, and `POST /v1/reexecutors`
/ `…/withdraw` return the unsigned XDR with the re-executor row — when
signing those, take the passphrase from `GET /v1/config`, a submission
response, or your own configuration.

### Errors

Every error body is `{ "error": "<message>" }`, with one addition:

| Status | When | Body |
|---|---|---|
| 400 | request validation | `{ "error": "<path>: <message>; …" }` (one entry per invalid field) |
| 400/403/404 | hand-written route checks | `{ "error": … }` — e.g. 404 `{ "error": "not found" }`, 403 `{ "error": "forbidden" }` on the ownership checks above |
| 400/403/422/502/503/504 | relay checks | `{ "error": … }` |
| 413 | artifact over `ARTIFACT_MAX_BYTES` (default 262144; request bodies cap at 1 MiB) | `{ "error": … }` |
| 507 | artifact store is full (`ARTIFACT_MAX_TOTAL_BYTES`) | `{ "error": … }` |
| 422 | the contract rejected the transaction | `{ "error": "EscrowGate rejected the transaction: <ErrorName>", "contract_error": "<ErrorName>" }` |
| 500 | anything unexpected | `{ "error": "internal error" }` |

`contract_error` appears **only** on that contract-rejection path; the 422
the relayer produces for a network rejection carries `error` alone.

### Rate limiting

Two limits apply to every request, and a request must stay under both:

- `RATE_LIMIT_PER_MINUTE` requests per minute (default 300) per **client
  address**. Every account a client signs in as draws from that same address
  budget, so minting identities does not multiply it.
- `RATE_LIMIT_PER_MINUTE` requests per minute per **authenticated account**,
  on top of the address budget. Unauthenticated requests, and requests with
  an invalid token, skip this one.

Sign-in has its own, much lower per-address budget:
`AUTH_REQUESTS_PER_MINUTE` (default 20) covers `GET /auth` and `POST /auth`
together. `POST /v1/artifacts` additionally allows only
`ARTIFACT_UPLOADS_PER_MINUTE` uploads per minute per account **and** per
client address. `/health*` is exempt.

The client address comes from `X-Forwarded-For` only when `TRUST_PROXY=true`.
The dashboard's server proxies every visitor, so behind it the backend must
trust the proxy; otherwise all visitors share one budget.

### Idempotency of `POST /v1/submissions`

`idempotency_key` is required and scoped to the authenticated account. Retries
are safe — a wallet prompt can be dismissed or a tab closed between build and
relay:

| Case | Response |
|---|---|
| key used by a *different* account | keys are scoped to the authenticated account; another account may reuse the same key independently (201 with its own draft) |
| same account, submission already on-chain | 200 `{ submission, unsigned_transaction_xdr: null, network_passphrase }` — nothing to sign |
| same account, relayed transaction already landed | 200 `{ submission, unsigned_transaction_xdr: null, network_passphrase }` — nothing to sign; the indexer attaches `chain_submission_id` |
| same account, draft relayed and possibly still landing (within the 5.5-minute validity window) | 409 `{ "error": "An earlier attempt for this idempotency_key was already sent to the network and may still confirm. Retry in a few minutes; it will resolve to that submission if it lands." }` — retry after a few minutes |
| same account, draft never relayed, or earlier relay failed or expired | draft updated, fresh transaction built; 200 `{ submission, unsigned_transaction_xdr, network_passphrase }` |
| new key for this account | 201 with the same three fields |

Unsigned drafts older than `DRAFT_TTL_S` (default 3600 s) are purged by the
scheduler. In the rare race where a concurrent request for the same account
collides with a draft that is purged between insert and re-read, the endpoint
returns 409 `{ "error": "idempotency_key is already in use" }`.

See [Webhooks](#webhooks) for registration, payloads and signature verification.

### Webhooks

Webhooks notify the marketplace associated with the account that submitted the
work. `POST /v1/submissions` finds or creates this marketplace for the
authenticated submitting Stellar account. Alternatively,
`POST /v1/marketplaces` (bearer token; `{"name":"My marketplace"}`) creates
or returns that account's marketplace.

Register a subscription with
`POST /v1/marketplaces/:id/webhooks`, using a bearer token belonging to that
marketplace's Stellar account:

```json
{
  "url": "https://example.org/verity-webhook",
  "secret": "replace-with-a-long-random-secret",
  "events": ["submission.verified", "submission.slashed", "submission.disputed"]
}
```

The request requires a valid URL of at most 2048 characters, a `secret` of 8
to 256 characters, and a non-empty `events` array drawn from `submission.verified`,
`submission.slashed` and `submission.disputed`; any other name is rejected
with HTTP 400 and duplicates are stored once. The marketplace ID is a UUID;
only its own account may register a webhook (otherwise HTTP 403). A
successful registration returns the subscription row with HTTP 201. A
marketplace can hold at most 10 subscriptions (HTTP 409 beyond that);
deactivating one does not free its slot. The URL must resolve to a public
address: private, loopback, link-local, multicast and reserved ranges (and IPv6
forms that wrap them) are refused with HTTP 400, both at registration and again
at every delivery, which connects to the address it just checked.

`GET /v1/marketplaces/:id/webhooks` lists the marketplace's subscriptions
(`id`, `url`, `events`, `active`, `created_at`; the `secret` is never
returned). `PATCH /v1/marketplaces/:id/webhooks/:webhookId` with
`{"active": false}` stops deliveries to a subscription and `{"active": true}`
resumes them; it returns the updated subscription, or HTTP 404 if that
webhook does not exist on this marketplace. Both require the marketplace's own
account (otherwise HTTP 403).

| Event | When emitted | `data` |
| --- | --- | --- |
| `submission.verified` | First transition into the `verified` terminal status | `submission_id`, `status: "verified"`, `tx_hash` |
| `submission.slashed` | First transition into the `slashed` terminal status | `submission_id`, `status: "slashed"`, `tx_hash` |
| `submission.disputed` | When a new on-chain challenge is first recorded | `submission_id`, `status: "disputed"`, `tx_hash` |

The `submission_id` is Verity's submission **UUID**, not its numeric on-chain
submission ID. `tx_hash` is the relevant finalize/resolve or challenge
transaction hash and can be `null` if a terminal verdict is first observed
by reconciliation. The `expired_unverified` terminal status sends **no**
webhook. A `submission.verified` event can result from a window expiring
without consensus; inspect the submission's `resolution_method` via
`GET /v1/submissions/:id` to distinguish how the verdict was reached.

Each delivery is an HTTP `POST` with `content-type: application/json` and
three headers (`x-verity-delivery`, `x-verity-timestamp`, `x-verity-signature`), containing the UTF-8 JSON serialization
`JSON.stringify({ event: eventType, data: payload })`. For example, this is
only a **shape example**; the identifiers below are placeholders:

```json
{
  "event": "submission.verified",
  "data": {
    "submission_id": "<verity-submission-uuid>",
    "status": "verified",
    "tx_hash": null
  }
}
```

`x-verity-delivery` is the delivery UUID and `x-verity-timestamp` is the Unix
time, in whole seconds, when the request was sent. `x-verity-signature` is the
**lowercase hexadecimal HMAC-SHA256** digest using the registration `secret` as
the key over the string `${timestamp}.${deliveryId}.${rawBody}`, where
`rawBody` is the **exact raw request body**. Verify before parsing JSON:
re-serializing a parsed object may change the signed bytes. Reject deliveries
whose timestamp is outside a tolerance window (for example 5 minutes) to stop
replays, and use the delivery id to deduplicate. A valid HMAC shows that a
holder of the shared secret authenticated these bytes; it does not prove the
verdict or other payload data is correct. Any holder of the secret can
generate signatures. This minimal Node.js receiver verifies the
header using a constant-time comparison:

```js
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const secret = process.env.VERITY_WEBHOOK_SECRET;
if (!secret || secret.length < 8) throw new Error("Set VERITY_WEBHOOK_SECRET");

createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  const provided = req.headers["x-verity-signature"];
  const timestamp = req.headers["x-verity-timestamp"];
  const deliveryId = req.headers["x-verity-delivery"];
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (typeof timestamp !== "string" || typeof deliveryId !== "string" || !(age <= 300)) {
    res.writeHead(401).end();
    return;
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${deliveryId}.`)
    .update(rawBody)
    .digest();

  const valid = typeof provided === "string"
    && /^[0-9a-f]{64}$/.test(provided)
    && timingSafeEqual(Buffer.from(provided, "hex"), expected);
  if (!valid) {
    res.writeHead(401).end();
    return;
  }

  const message = JSON.parse(rawBody.toString("utf8"));
  console.log(message.event, message.data);
  res.writeHead(204).end();
}).listen(8080);
```

**URL rule: public addresses only.** Use a publicly reachable `http:` or
`https:` receiver URL whose host resolves. At registration, an unresolvable
host or an address rejected by `assertPublicHttpUrl` returns HTTP 400.
The guard rejects private, loopback and link-local addresses it recognizes.
Its checks do not cover every non-public IP range, so passing validation is
not a comprehensive network isolation guarantee.
The address check runs both at registration and immediately before delivery.
Redirects are not followed: any redirect fails the delivery.

**Delivery is best-effort: one attempt, no retry.** A delivery times out
after 5 seconds. HTTP 2xx counts as delivered; other responses, timeouts,
redirects, and transport failures count as failed. The backend records
delivery attempts internally but provides no delivery-history API.
Deliveries run in the background after the verdict is recorded and never
block verdict handling. Failed HTTP responses and transport errors are
recorded in `webhook_delivery` and logged by the dispatcher; a delivery still
in flight when the process exits stays `pending`.
No delivery to a receiver is guaranteed.


### Verify an attestation

Fetch `GET /v1/submissions/:id/attestation` using Verity's submission UUID,
not the on-chain submission ID. Replace the example UUID below with a real
settled submission from your backend:

```bash
curl --fail-with-body http://localhost:3001/v1/submissions/00000000-0000-0000-0000-000000000000/attestation
```

A non-UUID ID returns HTTP 400. HTTP 404 means no attestation exists yet:
it is issued in the settlement pass after a terminal verdict and release of
indexed attestation locks, not immediately on finalisation.

The response contains `payload`, `canonical`, `signature`,
`signature_algorithm`, `signer`, `delivered_to` and `issued_at`:

- `canonical` is the exact UTF-8 string that was signed: canonical JSON of
  `payload`, with object keys sorted recursively and no whitespace. The API
  recomputes it from the stored payload. Verify these bytes directly and
  confirm that the response `payload` canonicalizes to the same string;
  verifying the signature on `canonical` alone does **not** authenticate
  a separately modified `payload`.
- `signature` is the base64-encoded raw 64-byte ed25519 signature;
  `signature_algorithm` is `"ed25519"`.
- `signer` is the attestation signing key's Stellar G-address, also recorded as
  `payload.attestor.stellar_account`. It is the keeper unless the operator set
  `ATTESTATION_SIGNING_SECRET`, in which case it is that separate key. Pin it to
  the key your deployment operator publishes (the `keeper_public_key` in your
  trusted `deployments/<name>.json` when no separate key is set). If the
  signing key rotates, **independently** verify the replacement public key with
  your deployment operator and explicitly pin it with
  `TRUSTED_KEEPER_PUBLIC_KEY` for new attestations. Keep the old pin for
  historical records: the deployment JSON may retain the original key.
  Never derive a trusted key from this unverified response.
- `delivered_to` is `null`: the record is signed and served by the API,
  with nothing pushed to Stellar 8004 or any other registry.

The signed `verity.attestation.v2` payload identifies the network and
EscrowGate contract, attestor, subject (agent, escrow reference, Verity UUID
and chain submission ID), claim (task type, verdict, resolution method and
indexed attestations), submit/finalise transaction hashes and `issued_at`.
Each claim attestation contains `reexecutor`, `matched` and `tx_hash`.
Verdicts are `verified`, `slashed` or `expired_unverified`.
`payload.issued_at` is inside the signed bytes; the response-level
`issued_at` is the database export time and is **not** signed.

From the repository root after `pnpm install`, run this Node.js example.
Set `SUBMISSION_ID` to a real settled UUID. `API` defaults to the local
backend; `DEPLOYMENT` selects the trusted deployment file (default `testnet`).
If your keeper rotated, first verify its **new** G-address through a
separately authenticated operator/deployment channel, then run the example
with `TRUSTED_KEEPER_PUBLIC_KEY=G...` to explicitly trust it. Do not set the
override to `att.signer` or copy the response value before verifying its
provenance. An old attestation must still be checked against its old key.
Select the **trusted deployment configuration for the specific submission**,
not one supplied by an untrusted API. A valid signature alone does not
prove that the attestation concerns the UUID or contract you requested.

```bash
SUBMISSION_ID=00000000-0000-0000-0000-000000000000 node --input-type=module <<'JS'
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("./backend/package.json", import.meta.url));
const { Keypair } = require("@stellar/stellar-sdk");

const API = process.env.API ?? "http://localhost:3001";
const id = process.env.SUBMISSION_ID;
if (!id) throw new Error("Set SUBMISSION_ID to a settled Verity submission UUID");
const deployment = JSON.parse(readFileSync(
  `deployments/${process.env.DEPLOYMENT ?? "testnet"}.json`, "utf8"
));
const response = await fetch(`${API}/v1/submissions/${encodeURIComponent(id)}/attestation`);
if (!response.ok) throw new Error(`Attestation HTTP ${response.status}: ${await response.text()}`);
const att = await response.json();
if (att.signature_algorithm !== "ed25519") throw new Error("Unexpected algorithm");
const trustedSigner = process.env.TRUSTED_KEEPER_PUBLIC_KEY ?? deployment.keeper_public_key;
if (!trustedSigner || att.signer !== trustedSigner)
  throw new Error("Unexpected keeper signer");
const key = Keypair.fromPublicKey(att.signer);
const signature = Buffer.from(att.signature, "base64");
// Mirror backend/src/chain/canonical.ts; compare before trusting att.payload.
function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
if (typeof att.canonical !== "string" || canonicalJson(att.payload) !== att.canonical)
  throw new Error("Attestation payload does not match signed canonical bytes");
if (att.payload?.attestor?.stellar_account !== att.signer)
  throw new Error("Attestation signer does not match attestor");
const message = Buffer.from(att.canonical, "utf8");
if (signature.length !== 64 || !key.verify(message, signature))
  throw new Error("Invalid attestation signature");
if (key.verify(Buffer.concat([message, Buffer.from(" ")]), signature))
  throw new Error("Tampered canonical string unexpectedly verified");
// Bind the authenticated bytes to this request and the selected deployment.
if (att.payload?.schema !== "verity.attestation.v2")
  throw new Error("Unexpected attestation schema");
if (att.payload?.subject?.submission_id !== id)
  throw new Error("Attestation does not belong to the requested submission");
if (typeof deployment.network_passphrase !== "string" ||
    !deployment.network_passphrase ||
    att.payload.network_passphrase !== deployment.network_passphrase)
  throw new Error("Attestation network does not match the trusted deployment");
if (typeof deployment.escrow_gate_contract_id !== "string" ||
    !deployment.escrow_gate_contract_id ||
    att.payload.escrow_gate_contract_id !== deployment.escrow_gate_contract_id)
  throw new Error("Attestation contract does not match the trusted deployment");
console.log("Signature valid; signer, submission and deployment context verified");
JS
```

A valid signature shows that Verity's keeper key attested to these verdict
record bytes; it is not a cryptographic proof of correctness. Check the
signed record's `finalize_tx_hash` and the contract for the verdict itself:
the contract is the authority. `claim.attestations` contains only votes the
backend indexed as `confirmed_onchain`, ordered by transaction hash. If the
indexer is missing votes, settlement waits up to 600 seconds, then may issue
the record with incomplete evidence. Read the on-chain submission for the
full tally.

## Known limits

- **Testnet only. Contracts are unaudited.**
- **What "verified" covers.** The input and claimed-output hashes are
  committed on-chain; the function is stored by hash but not committed. A
  verdict means "consistent with the artifacts the agent declared".
- **No escrow is gated yet.** `example-marketplace-escrow` shows the
  integration but is not deployed; `escrow_value` is declared by the agent.
- **Voter set.** Stake is free on testnet, so an open voter set could be
  captured at no cost. Deployments here run with `reexecutor_allowlist` on:
  the admin approves which staked accounts may vote.
- **Sandbox limits.** Replay limits and constraints are detailed in
  [Writing replayable work](#writing-replayable-work). Exceeding an engine
  limit or throwing is a mismatch. A function that stalls a re-executor's host
  without exceeding an engine limit gets no vote from it.
- **Assignment** is deterministic and auditable but uniform, not
  stake-weighted. It only picks re-executors whose worker is online, and asks
  another when one goes quiet.
- **Stellar 8004.** Verdicts are stored as signed attestation payloads and
  served by the API; they are not pushed to an 8004 registry, whose ingestion
  schema is not published.
- **False-accept rate** needs a manual audit sample and is reported as `null`.
- **One backend instance** runs the indexer and keeper; artifacts are on its
  local disk; webhooks are delivered once with no retry.
- **Containers.** The three images build, and the full stack has been run
  from them (Postgres, migrations, backend, three re-executors, dashboard)
  and passed the smoke test, using podman with the services started one by
  one. `docker-compose.yml` describes the same services but has not itself
  been executed: the machine this was developed on has no compose provider.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, checks and the PR flow,
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for a map of the code, and
[`SECURITY.md`](SECURITY.md) for reporting a vulnerability. Licensed under
[Apache-2.0](LICENSE).
