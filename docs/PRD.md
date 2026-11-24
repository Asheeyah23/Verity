# Verity product requirements

**What it is:** a phased, honest verification layer that lets a Soroban escrow release funds to
an AI agent only after the agent's claimed task completion has been checked — first cheaply by
optimistic replay and statistical spot-check, later by selective zero-knowledge proofs for
high-value disputes — instead of trusting the agent's self-report or a third party's attestation.
**Addresses:** frontier 7.1 from the Stellar AI-agent research (the "epistemological problem of
agent truth" / verifiable inference).
**Version:** 1.0 · 2026-09-16 (updated 2026-11-22 with code-status table and shipped §8 signatures)
**Status:** Phase 1 shipped on Stellar testnet (optimistic replay and spot-check verification; no
ZK proving). Phase 2 (selective ZK proving) remains gated and inactive.
**Evidence labels:**
- **VERIFIED:** confirmed by the two deep-research rounds run 2026-09-16 on the Stellar
  AI-agent-economy frontier, with sources in §17.
- **REASONED:** follows from verified facts, not checked directly.
- **ASSUMPTION:** a guess to test in Phase 0.

## Status against the code (as of 2026-11-22)

This document was drafted on 2026-09-16 before implementation. Where the shipped Phase 1 codebase
differs from the original PRD text, the table below is authoritative:

| PRD section | Original PRD statement | What ships today | Where |
|---|---|---|---|
| §3 Goal 1 | `verify()` call returning a "confidence-scored verdict" | `EscrowGate::finalize()` returns a discrete `Verdict` enum paired with a `ResolutionMethod` (`None`, `ReexecutionConsensus`, `WindowElapsed`); no confidence score exists in the contract or API. | [`contracts/common/src/types.rs:16-48`](../contracts/common/src/types.rs#L16-L48), [`contracts/escrow-gate/src/lib.rs:673`](../contracts/escrow-gate/src/lib.rs#L673), [README ("How a submission is verified")](../README.md#how-a-submission-is-verified) |
| §5 Phase 1 | `EscrowGate` "Returns `Pending`, `Verified`, or `Disputed`" | Five `Verdict` variants: `Pending`, `Verified`, `Disputed`, `Slashed`, and `ExpiredUnverified` (used when a challenge or contested window expires without quorum). | [`contracts/common/src/types.rs:16-22`](../contracts/common/src/types.rs#L16-L22), [README ("How a submission is verified")](../README.md#how-a-submission-is-verified) |
| §5 Phase 1 | A random 10–20% subset of retrieval submissions is spot-checked, and a mismatch "slashes the agent's bond" | Every retrieval submission gets one sampled re-executor spot-check. A match lets the submission verify by default when its window closes; a mismatch escalates that submission (and the agent's other pending submissions) to a full replay quorum, which decides slashing. | [`backend/src/modules/reexecutors/assignment.ts:108-154`](../backend/src/modules/reexecutors/assignment.ts#L108-L154), [`backend/src/workers/indexer.ts:237-250`](../backend/src/workers/indexer.ts#L237-L250), [README ("How a submission is verified")](../README.md#how-a-submission-is-verified) |
| §8 Contract interfaces | Originally sketched `slash(e, admin_or_keeper, reexecutor, submission_id, amount: i128)` and omitted `escrow_value` from `submit` | `slash(e, reexecutor, submission_id) -> Result<i128, Error>` is permissionless with the slash share fixed on-chain (`cfg_reexecutor_slash_bps`, snapshotted at `submit()` time) and also enforced by `release_attestation_lock()`; `submit()` takes `escrow_value: i128` for proportional bonds. §8 below has been updated to match the shipped contract. | [`contracts/escrow-gate/src/lib.rs:295-304`](../contracts/escrow-gate/src/lib.rs#L295-L304), [`contracts/escrow-gate/src/lib.rs:726-750`](../contracts/escrow-gate/src/lib.rs#L726-L750), [`deployments/interfaces/escrow_gate.json`](../deployments/interfaces/escrow_gate.json), [README ("How a submission is verified")](../README.md#how-a-submission-is-verified) |
| §9 API (v1) | Lists a `zk_proof.verified` webhook event | Backend accepts and dispatches only `submission.verified`, `submission.slashed`, and `submission.disputed` (other names return HTTP 400); `expired_unverified` emits no webhook and Phase 1 has no ZK proofs. | [`backend/src/modules/marketplaces/routes.ts:10`](../backend/src/modules/marketplaces/routes.ts#L10), [README ("Webhooks")](../README.md#webhooks) |
| §10 Security | "Stake-weighted selection" for Re-executors | Off-chain assignment is deterministic and uniform (`sha256(seed \| account)`) over online eligible workers, not stake-weighted (on-chain vote tallies in `EscrowGate` are stake-weighted). Testnet deployments also run with `reexecutor_allowlist` enabled because testnet stake is free. | [`backend/src/modules/reexecutors/assignment.ts:18-45`](../backend/src/modules/reexecutors/assignment.ts#L18-L45), [README ("Known limits")](../README.md#known-limits) |
| §5 Phase 3 (and §4) | Cited `prd-04-multiagent-coalitions.md` (and `prd-05`) | Neither external research-series draft exists in this repository; both references are footnoted below. | §4 and §5 Phase 3 below |

---

## 1. Summary

Soroban escrow contracts that pay AI agents for completed work have no native way to check that
the work was actually done, or done correctly. The contract sees a submitted result and releases
funds; it cannot tell a correct answer from a hallucinated one or a "did the bare minimum to pass"
one. The one mechanism that exists to fix this — Zero-Knowledge Machine Learning (ZK-ML), which
would let an agent submit a cryptographic proof that a specific model produced a specific output —
is real research, actively improving, and **not usable in production today**: proving a single
transformer inference costs orders of magnitude more than running it, and can take hours to weeks
end to end (VERIFIED, §17).

Verity does not promise what the field cannot yet deliver. It ships an **optimistic verification
layer first** — fast, cheap, and good enough to kill the obvious "submit garbage, collect the
bounty" exploit — with a **narrow, selective ZK-proving escalation path** reserved for disputes
large enough to justify the cost, added only once the underlying ZK tooling clears a defined
performance bar. It is infrastructure other Soroban escrow products (agent marketplaces, bounty
boards, x402-settled task platforms) plug into, not a marketplace itself.

---

## 2. Problem and evidence

> *Research snapshot: this section reflects the 2026-09-16 research date and is preserved as written.*

### 2.1 Pain statements

> **A bounty poster on a Soroban agent marketplace** (the kind of escrow described for Hive and
> XLMx402earn-style platforms) has no way to check that a submitted result reflects real,
> competent effort rather than a fast, low-effort, or fabricated answer, before the contract
> releases payment. The contract's `release()` call has no concept of correctness — only "was a
> result submitted." REASONED from Soroban's execution model (a contract can verify a signature or
> a hash, not the semantic correctness of arbitrary off-chain computation) plus the verified
> absence of any production on-chain verifier for this (below).

> **An agent operator who wants to prove honesty** has exactly two options today, and both shift
> trust rather than removing it: (a) submit to a third-party attestation registry like Stellar
> 8004's Validation Registry, where a human or another centralized actor vouches for behavior after
> the fact (VERIFIED — this is attestation, not proof), or (b) submit to a project like AgentVeritas
> that does non-cryptographic, rule-based static analysis of the agent's own claims (VERIFIED — 1
> star, 0 forks, 5 commits, testnet-only). Neither gives the escrow contract a mathematical
> guarantee.

> **A platform that wants to market "verified AI outputs"** is one hackathon landing page away from
> overclaiming. A live example: a project at `sap-lyart.vercel.app` advertises a "Multi-Agent ZK
> Consensus" mechanism that supposedly requires independent validator agents to verify output
> before Soroban escrow release. This claim was adversarially checked against the project's own
> stated architecture and **refuted 0-3** — no evidence backs it up as a working mechanism. VERIFIED.
> This is the shape of claim any credible entrant in this space must be visibly better than.

### 2.2 The numbers

| Fact | Value | Status |
|---|---|---|
| ZKML-Soroban pipeline completeness | Steps 1–3 and 5 of 5 implemented; Groth16 compression (step 4) and direct ONNX CLI ingestion pending; **no production ZK-ML proof verified on-chain yet** | VERIFIED (project's own README/status table) |
| ZK-SNARK proving overhead for transformer-scale inference vs. native inference | "Orders of magnitude higher" (VeriLLM paper framing) | VERIFIED |
| Measured proving latency, LLaMA-2-7B | ~2,646 seconds/token | VERIFIED (independent benchmark cited in VeriLLM, arXiv:2509.24257) |
| Measured proving latency, LLaMA-2-13B | 986s + 803s (two-stage) | VERIFIED |
| VeriLLM's own (non-ZK, probabilistic) verification cost vs. raw inference | ~1% of inference cost, via re-deriving hidden states in the parallel Prefill phase | VERIFIED |
| Full end-to-end ZK-ML proof generation time, general case | Hours to weeks per inference | VERIFIED (Springer, 10.1007/s44443-026-00573-1, Feb 2026) |
| NanoZK per-layer proof size | 3.5–3.7 KB/layer, ~83 KB total for a 12-layer model (vs. 101–126 KB monolithic in prior ZKML systems) | VERIFIED (arXiv:2603.18046) — but the production-scale transformer-block number (d=768, ~68s/block GPU) is an **extrapolated projection**, not a direct measurement; directly measured only up to d=128 |
| zk-OPML | Peer-reviewed, accepted Feb 2026; hybrid ZK/optimistic approach using selective, operator-level ZK proofs | VERIFIED — most credible "this is actively being worked on" signal in the field, unproven at production scale |
| General ZK proof systems (Groth16, Gemini, Winterfell, Halo2, Plonky2, zkCNN) vs. production ML-inference verification bar | Do not yet meet it | VERIFIED (Modulus Labs, eprint.iacr.org/2026/1063) |
| Field-wide bottlenecks named by peer review | "Limited circuit expressiveness, high proving cost, and deployment complexity" | VERIFIED (arXiv:2502.18535, 2026) |

### 2.3 Why now

| Clock | Signal | Status |
|---|---|---|
| Stellar Agents hackathon activity (260+ submissions reported around x402/MPP/Stripe agent tooling) | Large, fast-growing builder base creating agent-to-agent and human-to-agent escrow flows that all share this same unverified-completion gap | VERIFIED (dorahacks.io hackathon listing) |
| Stellar 8004 shipped (identity + reputation + Validation Registry, 3 Soroban contracts) | The ecosystem has already converged on "attestation" as the default answer — meaning the market has a felt need for agent trust, and has settled for a weaker mechanism than is ultimately needed | VERIFIED |
| zk-OPML and NanoZK both landed in the same window (Feb–2026 acceptance windows) | The academic frontier is visibly moving from "ZK-ML is a laboratory curiosity" toward "selective, hybrid ZK-ML is becoming tractable" — the first year in which a phased product bet like Verity's is technically defensible rather than purely speculative | VERIFIED |
| ZKML-Soroban exists but is stalled on exactly the hard step (Groth16 compression, step 4) | Shows genuine developer interest in solving this on Stellar specifically, and shows precisely where the difficulty is concentrated | VERIFIED |

### 2.4 What exists (and why it is not this)

| Project | What it does | Gap |
|---|---|---|
| **ZKML-Soroban** | Off-chain ML inference + on-chain Soroban verification target using BN254 + Poseidon primitives; genuine ZK-ML architecture | Incomplete pipeline (no Groth16 compression, no ONNX CLI ingestion); zero production on-chain proofs verified to date. A dependency, not a competitor — Verity should track this project and adopt its verifier once (if) it ships, rather than rebuild a ZK-ML stack from scratch. VERIFIED |
| **Stellar 8004 Validation Registry** | On-chain identity + reputation + third-party attestation for agents | Attestation shifts trust to the attestor; it is not a cryptographic proof of correctness. Verity should be a possible *attestor type* that 8004 can reference (a Verity dispute outcome is a strong attestation input), not a competitor to 8004's identity layer. VERIFIED |
| **AgentVeritas** (`furkan3152/agentveritas-stellar`) | Non-cryptographic, rule-based static analysis of agent claims; testnet only | 1 star, 0 forks, 5 commits — small, early, and architecturally a different approach (heuristic review, not proof or replay). No cryptographic or economic guarantee. VERIFIED |
| **StellAIverse `OracleBridge`** | Verifies task/data authenticity via signed attestations from a whitelisted set of "approved oracles" | Trusted-attestation approach (a fixed oracle allowlist vouches for data), not proof of computation; the whitelist itself is a centralization and collusion risk Verity is designed to avoid. VERIFIED |
| **`sap-lyart.vercel.app` "Multi-Agent ZK Consensus"** | Marketing claim of ZK-based multi-agent output verification | Claim adversarially checked and refuted 0-3; no evidence of a working system. Included here as the cautionary example this PRD must not resemble. VERIFIED |
| **General ZK-ML research (Modulus Labs, NanoZK, zk-OPML, VeriLLM)** | Real, improving cryptographic and hybrid verification techniques for ML inference | None of it is Soroban-specific, none is production-ready at the cost/latency needed for escrow release today, and none solves *non-ML* task verification (data scraping, formatting, API orchestration) — the majority of what agent marketplaces actually pay for. Verity's job is integration, sequencing, and the non-ZK-ML majority case, not new cryptography. VERIFIED |

---

## 3. Goals and non-goals

### Goals

1. Give any Soroban escrow contract a `verify()` call that returns a confidence-scored verdict on
   a submitted task result, backed by an economic and (later) cryptographic mechanism — not by
   trusting the submitting agent or a single attestor.
2. Ship a working, honest v1 that closes the obvious "lazy agent" exploit (submit hallucinated or
   trivial output to collect a bounty) using **optimistic verification** — cheap, fast, no ZK
   required — before any ZK-ML claim is made publicly.
3. Add **selective ZK proving** for high-value disputes only once a defined, public performance
   bar is met by the field (see §5, Phase 2 gate) — never claim full ZK-ML verification of every
   inference.
4. Be the attestation *input*, not the identity layer: integrate with Stellar 8004 by publishing
   dispute outcomes as attestations, rather than building a competing identity/reputation system.
5. Be honest, in public, about what is and is not proven. Every public claim ships with the
   evidence behind it.

### Non-goals

- **Building a new ZK-ML proving system.** ZKML-Soroban, and the broader academic field, own that
  problem. Verity integrates a verifier once one is production-ready; it does not compete to build
  one.
- **Being an agent marketplace.** Hive, XLMx402earn-style platforms, and similar are the customers;
  Verity is infrastructure they call.
- **Replacing Stellar 8004.** 8004 owns identity and general reputation. Verity owns
  task-completion verification and feeds outcomes into 8004 as one attestation source among others.
- **Verifying every task type at launch.** v1 covers a defined set of verifiable task shapes
  (deterministic/replayable computation, and statistically spot-checkable retrieval/scraping
  tasks). Open-ended creative or subjective tasks (e.g. "write a good tweet") are explicitly out of
  scope until a scoring rubric exists that a re-executor can apply consistently.
- **Claiming cryptographic certainty in Phase 1.** Phase 1 is economic/statistical, not
  cryptographic. This must be stated plainly in all documentation and marketing.

---

## 4. Users and jobs to be done

| Persona | Job | Today | Willingness to pay (REASONED) |
|---|---|---|---|
| **Agent marketplace / bounty platform** (Hive-class, XLMx402earn-class) | "Don't let my escrow pay out for garbage work, without building my own verification stack" | Nothing, or a manual dispute process | Per-verification fee or bps on escrow value |
| **Bounty poster** | "Know my money only moves if the work is real" | Trusts the platform's own (usually absent) checks | Included in platform fee, or a premium "verified" tier |
| **Agent operator (honest)** | "Prove I did the work, get paid faster, build a reputation that survives disputes" | Nothing beyond self-report or an 8004 attestation from a party who has to trust them anyway | Free to use; benefits from faster payout and 8004-attestation credibility |
| **Insurer / underwriter (future, ties to frontier 7.5)** | "See a track record of independently verified task completions before extending credit to an agent" | Nothing — Blend and similar have no reputation term at all (VERIFIED, cross-reference frontier 7.5 underwriting-manifest-style work[^ext-prds]) | Data licence on verification outcomes |
| **Stellar 8004 ecosystem** | "A credible, non-circular attestation source to reference in the Validation Registry" | Attestors today are ad hoc and centralized | Free integration; distribution value, not direct revenue |

---

## 5. Product scope by phase

### Phase 0 — Discovery and kill criteria (weeks 0–6)

**Work:**
- Interview 4–6 agent-marketplace/bounty-platform builders on Stellar (targets: teams behind
  Hive-style and x402-settled bounty products; the SCF-funded "AI Agent Toolkit: Soroban to MCP"
  team, since it is live and funded — VERIFIED, §17) about whether unverified completion is a
  problem they actually feel, or one they route around by only trusting known-good agent operators.
- Define the v1 "verifiable task" taxonomy precisely: which task shapes can be checked by
  deterministic replay (e.g. a data transform, a formatted API call, a pure function over public
  inputs) vs. statistical spot-check (e.g. "did the agent actually query this API and return its
  real result" — checkable by re-querying) vs. currently unverifiable (open-ended generation,
  subjective judgment calls).
- Track ZKML-Soroban's roadmap directly (open an issue, ask about step 4/Groth16 timeline) —
  Verity's Phase 2 gate depends on it or an equivalent shipping.

**Kill criteria (stop if any is true):**
- No agent-marketplace builder will integrate a third-party verification call into their escrow
  release path (i.e., they'd rather build in-house or not verify at all).
- The verifiable-task taxonomy covers less than ~30% of real bounty volume on the platforms
  interviewed (meaning the addressable problem is too narrow to matter).
- A materially better-funded, materially more credible competing verification layer is already
  live on Stellar (re-run the "what exists" search from §2.4 before committing).

**Exit:** 1 signed design partner (a real marketplace willing to route escrow release through
Verity's `verify()` call in Phase 1); the taxonomy validated against at least 100 real historical
bounty submissions from that partner.

### Phase 1 — Optimistic Verification Layer (months 1–4)

**Deliverables**
- `EscrowGate` Soroban contract: a drop-in wrapper a marketplace's existing escrow contract calls
  before release. Returns `Pending`, `Verified`, or `Disputed`.
- **Replay verification** for deterministic tasks: the agent submits its result plus a
  content-addressed record of its inputs and the deterministic function it ran; a decentralized
  set of staked **Re-executors** replay the same function over the same inputs off-chain and post
  a match/mismatch attestation on-chain. Majority vote within a bonded quorum determines the
  verdict. This is the same *idea* as VeriLLM's re-derivation trick (recompute cheaply instead of
  proving cryptographically) generalized beyond LLM inference to arbitrary deterministic tasks —
  REASONED extension, not itself evidence-backed as built.
- **Statistical spot-check** for retrieval/scraping tasks: a random subset (ASSUMPTION: 10–20%,
  tuned in Phase 0) of submissions are independently re-executed by a Re-executor within a
  challenge window; a mismatch slashes the agent's bond and flags every other unverified
  submission from that agent for review.
- **Challenge window and fraud proof:** every submission has a configurable dispute window
  (ASSUMPTION default: 1 hour for sub-$50 bounties, 24 hours for larger ones) during which any
  bonded challenger can force a replay. No challenge within the window ⇒ auto-`Verified`. This
  is a fraud-proof / optimistic-rollup-style pattern, not a novel cryptographic mechanism —
  chosen specifically because it needs no ZK-ML breakthrough to work today.
- Reputation event export: every `Verified`/`Disputed` outcome is published as a signed event a
  Stellar 8004 attestor (or Verity's own optional registry) can ingest.

**Explicitly not claimed:** cryptographic proof of AI model correctness. Phase 1 marketing must
say "economically enforced, replay-checked" — never "verified inference" or "ZK-proven."

**Exit metric:** 1 live marketplace routing ≥500 real bounty submissions/month through
`EscrowGate`; false-accept rate (bad work marked `Verified`) measured against manual audit sample
below an agreed threshold (ASSUMPTION: <5%).

### Phase 2 — Selective ZK Proving (months 4–10, gated)

**Gate (all required before starting):**
- ZKML-Soroban or an equivalent ships a production-verified on-chain proof for at least one
  realistic model shape (i.e., completes its own step 4).
- Independent benchmark shows selective/operator-level ZK proving (zk-OPML-style) at a proving
  time and cost that a disputed high-value bounty (ASSUMPTION threshold: >$1,000) can absorb —
  e.g. proving cost under 10% of the disputed amount and completed within the challenge window.
- At least one Phase 1 dispute has occurred where a cryptographic proof (rather than re-execution
  consensus) would have resolved it faster or more conclusively.

**Deliverables (once gated open):**
- `ZKVerifierRegistry` contract: a pluggable registry of verifier keys per proof system (starting
  with whatever ZKML-Soroban or zk-OPML expose), so new proof systems can be added without
  redeploying `EscrowGate`.
- ZK proving is invoked **only** on disputed, high-value submissions that clear the Phase-1
  optimistic path's economic bar — i.e., ZK proving is the appeals court, not the default judge.
- Publish updated, dated benchmarks quarterly; if the field regresses or a claimed benchmark does
  not reproduce, say so publicly.

**Exit metric:** at least 3 real disputes resolved via ZK proof rather than re-execution consensus,
with proof cost and latency within the gate's bounds.

### Phase 3 — Task-Type Expansion and 8004 Integration (months 10+)

- Extend the verifiable-task taxonomy based on Phase 1/2 usage data.
- Formal integration as a recognized attestor type in Stellar 8004's Validation Registry (subject
  to 8004's own governance, which is out of Verity's control — ASSUMPTION this is achievable).
- Explore multi-agent task verification (a task completed by a coalition, cross-reference frontier
  7.4[^ext-prds]) once that primitive exists elsewhere.

---

## 6. Architecture

### 6.1 System diagram (textual)

```
        Bounty platform / marketplace (Hive-class, x402-settled)
                         │
                         │ calls before release
                         ▼
                 ┌───────────────┐
                 │  EscrowGate   │◄──────────────┐
                 │ (Soroban)     │                │
                 └──────┬────────┘                │
                         │ Pending → verdict       │ dispute / challenge
                         ▼                         │
   ┌───────────────────────────────────────┐       │
   │           Verity off-chain            │       │
   │  ┌───────────┐  ┌──────────────────┐  │       │
   │  │ Re-executor│  │ Spot-check       │  │───────┘
   │  │ network    │  │ scheduler        │  │
   │  │ (staked,   │  │ (random sample,  │  │
   │  │  bonded)   │  │  challenge mgmt) │  │
   │  └─────┬──────┘  └────────┬─────────┘  │
   │        │                  │             │
   │        ▼                  ▼             │
   │   Postgres: submissions, replays,       │
   │   verdicts, bonds, slashing events      │
   └─────────────────┬────────────────────────┘
                      │ (Phase 2 only)
                      ▼
             ┌─────────────────────┐
             │ ZKVerifierRegistry  │──► ZKML-Soroban / zk-OPML-class
             │ (Soroban)           │    external verifier (integrated,
             └─────────────────────┘    not built by Verity)
                      │
                      ▼
             Stellar 8004 Validation Registry
             (Verity publishes dispute outcomes as attestations)
```

### 6.2 Components

| Component | Responsibility | New / integrated |
|---|---|---|
| `EscrowGate` (Soroban) | Entry point a marketplace's escrow calls; holds verdict state per submission; enforces challenge window timing on-chain | New |
| Re-executor network | Staked, bonded off-chain workers that replay deterministic tasks or re-query retrieval tasks and post match/mismatch attestations | New (economic design; workers can be a permissioned bootstrap set in Phase 1, opening to permissionless staking once bonded-slashing logic is audited) |
| Spot-check scheduler | Picks the random-sample subset for statistical checking; manages challenge windows and timers | New |
| `ZKVerifierRegistry` (Soroban) | Pluggable registry mapping proof systems to on-chain verifier contracts | New contract, wraps external verifiers (Phase 2) |
| Stellar 8004 attestation export | Publishes signed verdict events in the shape 8004's Validation Registry expects | Integration, not owned |
| ZKML-Soroban / zk-OPML verifier | The actual ZK-ML cryptographic verification, once production-ready | External dependency, tracked not built |

### 6.3 Key technical decisions

| Decision | Choice | Why |
|---|---|---|
| v1 verification mechanism | Optimistic replay + statistical spot-check + bonded challenge, **not** ZK-ML | ZK-ML proving cost/latency is prohibitive today (§2.2); an economic mechanism can ship now and closes the same "lazy agent" exploit for the majority of task shapes |
| ZK proving role | Appeals-court escalation for high-value disputes only, gated on an explicit, public performance bar | Avoids overclaiming; keeps Verity honest about field maturity; matches zk-OPML's own hybrid framing |
| Re-executor trust model | Staked and bonded, slashed on provable mismatch with the eventual on-chain-checkable outcome (for deterministic tasks) or on losing a dispute (for statistical spot-checks) | Same fraud-proof economics as optimistic rollups; does not require new cryptography |
| Relationship to Stellar 8004 | Attestation *supplier*, not identity/reputation competitor | 8004 already has ecosystem traction (hackathon-built but real, VERIFIED); duplicating it wastes effort and fragments trust signals |
| Relationship to ZKML-Soroban | Integrate, don't rebuild | It is the only dedicated Stellar ZK-ML effort; rebuilding a competing stack would be redundant given the field's cost bottleneck is shared, not Stellar-specific |
| Task-type scope at launch | Deterministic-replayable + statistically-spot-checkable only | Matches what can actually be verified without new research; open-ended/subjective tasks are explicitly deferred |

---

## 7. Data model (Postgres)

```sql
submission (
  id uuid pk, escrow_ref text, marketplace_id uuid fk, agent_id text,
  task_type text check (task_type in ('deterministic','retrieval','unverifiable')),
  input_hash text, claimed_output_hash text, claimed_output_ref text,
  bond_amount numeric, bond_asset text, submitted_at timestamptz,
  challenge_window_s int, status text check (status in
    ('pending','verified','disputed','slashed','expired_unverified'))
)

reexecutor (
  id uuid pk, stellar_account text, stake_amount numeric, stake_asset text,
  reputation_score numeric, active bool, slashed_count int, joined_at timestamptz
)

replay (
  id uuid pk, submission_id fk, reexecutor_id fk, replay_output_hash text,
  match bool, latency_ms int, cost numeric, executed_at timestamptz
)

spot_check (
  id uuid pk, submission_id fk, sampled_at timestamptz, reexecutor_id fk,
  result text check (result in ('match','mismatch','inconclusive')), evidence jsonb
)

challenge (
  id uuid pk, submission_id fk, challenger_account text, challenger_bond numeric,
  opened_at timestamptz, resolved_at timestamptz,
  resolution text check (resolution in ('upheld','rejected')), resolution_method text
    check (resolution_method in ('reexecution_consensus','zk_proof','manual_review'))
)

zk_proof (
  id uuid pk, submission_id fk, proof_system text, verifier_contract text,
  proof_blob_ref text, verified_onchain bool, tx_hash text, cost numeric,
  proving_time_ms int, created_at timestamptz
)

attestation_export (
  id uuid pk, submission_id fk, target_registry text default 'stellar-8004',
  payload jsonb, signature text, exported_at timestamptz
)

slashing_event (
  id uuid pk, reexecutor_id fk, submission_id fk, amount numeric, reason text,
  tx_hash text, created_at timestamptz
)
```

---

## 8. Contract interfaces (shipped Phase 1, Rust / soroban-sdk)

> *Updated against the shipped contracts in [`contracts/escrow-gate/src/lib.rs`](../contracts/escrow-gate/src/lib.rs) and [`contracts/zk-verifier-registry/src/lib.rs`](../contracts/zk-verifier-registry/src/lib.rs); full exported ABIs live in [`deployments/interfaces/escrow_gate.json`](../deployments/interfaces/escrow_gate.json) and [`deployments/interfaces/zk_verifier_registry.json`](../deployments/interfaces/zk_verifier_registry.json). The original 2026-09-16 draft sketched `slash(e, admin_or_keeper, reexecutor, submission_id, amount)` and omitted `escrow_value` from `submit`; the shipped contract makes `slash` permissionless with an on-chain fixed rate (enforcing invariant 2) and passes `escrow_value` to `submit` (enforcing invariant 5).*

```rust
// EscrowGate (contracts/escrow-gate/src/lib.rs)
pub fn submit(
    e: Env,
    agent: Address,
    escrow_ref: BytesN<32>,
    escrow_value: i128,
    task_type: TaskType,
    input_hash: BytesN<32>,
    output_hash: BytesN<32>,
    bond: i128,
) -> Result<u64, Error>;
pub fn register_reexecutor(e: Env, reexecutor: Address, stake_amount: i128) -> Result<(), Error>;
pub fn withdraw_stake(e: Env, reexecutor: Address, amount: i128) -> Result<(), Error>;
pub fn attest_replay(
    e: Env,
    reexecutor: Address,
    submission_id: u64,
    output_hash: BytesN<32>,
    matched: bool,
) -> Result<(), Error>;
pub fn release_attestation_lock(
    e: Env,
    submission_id: u64,
    reexecutor: Address,
) -> Result<(), Error>;
pub fn open_challenge(
    e: Env,
    challenger: Address,
    submission_id: u64,
    bond: i128,
) -> Result<(), Error>;
pub fn resolve_challenge(
    e: Env,
    submission_id: u64,
    method: ResolutionMethod,
) -> Result<Verdict, Error>;
pub fn finalize(e: Env, submission_id: u64) -> Result<Verdict, Error>; // called by marketplace before release
pub fn slash(e: Env, reexecutor: Address, submission_id: u64) -> Result<i128, Error>;

// ZkVerifierRegistry (contracts/zk-verifier-registry/src/lib.rs — deployed empty as Phase 2 anchor)
pub fn register_verifier(
    e: Env,
    admin: Address,
    proof_system: Symbol,
    verifier_contract: Address,
) -> Result<(), Error>;
pub fn deregister_verifier(e: Env, admin: Address, proof_system: Symbol) -> Result<(), Error>;
pub fn verify_proof(
    e: Env,
    proof_system: Symbol,
    submission_id: u64,
    proof: Bytes,
) -> Result<bool, Error>;
```

### Invariants (property tests and audit targets)

1. **No auto-verify before the challenge window closes**, unless a `Verified` majority of bonded
   Re-executor replays already exists.
2. **A slash can only follow a provable mismatch** (a reproducible replay divergence for
   deterministic tasks, or a resolved challenge for spot-checks) — never an admin discretionary
   call.
3. **`finalize()` is idempotent and irreversible** once called — the marketplace's escrow release
   must not be able to race or double-spend a verdict.
4. **`ZKVerifierRegistry.verify_proof` cannot be forced to accept a proof for a proof system it has
   not explicitly registered** — no default-accept path.
5. **Bond amounts are proportional to task value** (agent bond and challenger bond scale with the
   escrow amount) so the game stays economically rational at both small and large bounty sizes.

---

## 9. API (v1)

```
Auth: SEP-10 JWT for agent/marketplace accounts operating a Stellar identity.

POST   /v1/submissions                 marketplace or agent posts a completed task for verification
GET    /v1/submissions/{id}            status, verdict, replay/spot-check history
POST   /v1/submissions/{id}/challenge  open a bonded challenge within the window
GET    /v1/submissions/{id}/proof      (Phase 2) fetch the ZK proof artifact and verification tx

POST   /v1/reexecutors                 register/stake as a Re-executor
GET    /v1/reexecutors/{id}            reputation, stake, slash history

GET    /v1/taxonomy                    the current verifiable-task-type schema and examples
GET    /v1/reports/verification-rates  aggregate verified/disputed/slashed rates by marketplace, task type

Webhooks: submission.verified · submission.disputed · submission.slashed · zk_proof.verified
```

---

## 10. Security, compliance, privacy

- **No custody.** Verity never holds bounty escrow funds; it only writes a verdict the
  marketplace's own escrow contract reads before releasing its own held funds.
- **Sybil resistance on Re-executors.** Stake-weighted selection, minimum stake floor, and
  reputation decay on repeated near-miss (rather than clear match/mismatch) verdicts.
- **Collusion risk.** A small Re-executor set that colludes to always confirm each other's replays
  defeats the model; mitigated by random reviewer assignment, a public audit log of every
  replay/attestation pair, and a bug-bounty-style reward for anyone who proves a collusion pattern.
- **No claim beyond the evidence.** Every public-facing document and UI element must state whether
  a given verdict was reached by re-execution consensus (Phase 1, economic) or ZK proof (Phase 2,
  cryptographic) — never blur the two.
- **Data handling.** Task inputs/outputs may contain customer data; Verity stores content hashes on
  -chain and full payloads off-chain under the marketplace's existing data-handling terms, not its
  own new data-retention regime.

---

## 11. Pricing

| Product | Payer | Model | Anchor (ASSUMPTION) |
|---|---|---|---|
| Verification calls | Marketplace | Per-submission fee or bps of escrow value | 0.5–2% of verified bounty value, undercutting the cost of an in-house verification team |
| Re-executor network participation | Re-executors | Earn a share of verification fees, proportional to replays performed and un-slashed | — |
| ZK proof escalation (Phase 2) | Disputing party (loser pays) | Flat fee covering proving cost + margin | Set once Phase 2 gate benchmarks are known |
| 8004 attestation export | Free | — | Distribution/credibility value, not direct revenue |

---

## 12. Metrics and SLOs

**North star:** verified bounty volume with no successful post-verification fraud claim, per
month (USD).

| Metric | Phase 1 (month 4) | Phase 2 (month 10) |
|---|---|---|
| Marketplaces integrated | 1 | 3 |
| Submissions verified/month | 500 | 5,000 |
| False-accept rate (audit sample) | < 5% | < 2% |
| Median time to `Verified` | < challenge window | < challenge window |
| Disputes resolved by re-execution consensus | tracked | tracked |
| Disputes resolved by ZK proof | n/a | ≥ 3, within gate cost/latency bounds |
| Re-executor slashing events (sign of a working deterrent, not a failure) | tracked | tracked |
| API availability | 99.5% | 99.9% |

---

## 13. Go-to-market

- **First design partner:** whichever Stellar bounty/agent-marketplace project is furthest along
  and open to integration risk — likely candidates surfaced in this research include Hive-style
  and x402-settled bounty platforms and the SCF-funded "AI Agent Toolkit: Soroban to MCP" project
  ($108K awarded, Build phase — VERIFIED, §17), since it is funded, live, and already building
  adjacent tooling.
- **Distribution:** the Stellar Agents hackathon ecosystem (260+ projects, VERIFIED) is the natural
  first audience — most of those projects have exactly this unverified-completion gap and are too
  early to have built their own fix.
- **Content:** publish the Phase 1 vs. Phase 2 honesty framing explicitly and often — "here is
  what we verify today, here is what we don't yet, here is the public bar that has to clear before
  we add ZK proving." This directly differentiates Verity from the refuted vaporware example in
  §2.4 and should be a deliberate part of the pitch to SCF and to marketplace partners.
- **SCF angle:** likely fits an Open or Integration track submission once Phase 0 validates
  partner interest; explicitly reference Stellar 8004 integration as a reason the ecosystem
  benefits rather than fragments.

---

## 14. Team and timeline

| Role | Phase 0–1 | Phase 2 |
|---|---|---|
| Founder / product | 1 | 1 |
| Soroban / Rust engineer (contracts) | 1 | 1 |
| Backend engineer (re-executor network, off-chain services) | 1 | 1 |
| Applied cryptography advisor (fractional, to evaluate ZK-ML integration readiness) | 0.2 | 0.5 |
| Security/audit | — | 1 audit before any mainnet fund-adjacent deployment |

| Phase | Months | Gate |
|---|---|---|
| 0 Discovery | 0–1.5 | 1 design partner signed; taxonomy validated on ≥100 real submissions |
| 1 Optimistic layer | 1.5–5.5 | 1 live marketplace, ≥500 submissions/month, false-accept rate <5% |
| 2 Selective ZK | 5.5–11.5 | Explicit gate in §5 cleared; ≥3 real disputes resolved by proof |
| 3 Expansion | 11.5+ | Task-taxonomy growth; 8004 attestor status |

---

## 15. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| No marketplace wants a third-party verification dependency in their critical payment path | Medium | Fatal | Phase 0 gate; offer as an optional, additive "verified" badge/tier before requiring integration |
| Re-executor collusion undermines the optimistic layer | Medium | High | Random assignment, public audit log, bounty for proven collusion, stake slashing |
| ZK-ML field stalls and the Phase 2 gate never clears | Medium | Medium (not fatal — Phase 1 stands alone) | Explicitly designed so Phase 1 is a complete, honest product on its own; Phase 2 is upside, not a dependency |
| A better-funded competitor (e.g. Stellar 8004 itself, or ZKML-Soroban's own team) ships an equivalent verification layer | Medium | High | Move fast on Phase 1 (cheap, no ZK dependency); position as complementary (8004 integration) rather than competitive from day one |
| Task taxonomy is too narrow to matter (most real bounty work is unverifiable, e.g. subjective creative tasks) | Medium | High | Phase 0 explicitly measures the % of real historical submissions the taxonomy covers before building |
| Overclaiming (marketing gets ahead of what Phase 1 actually proves) | Medium (self-inflicted) | High (reputational, see the refuted sap-lyart precedent) | Public, dated "what we verify vs. don't yet" statement; no "ZK-verified" language until Phase 2 ships and is independently checkable |
| Stellar 8004 governance does not recognize external attestors, or changes its schema | Low | Medium | Design the attestation export as a translatable event, not a hard dependency; Verity's core value (verification) works even if 8004 integration stalls |

---

## 16. Open questions for Phase 0

1. What fraction of real historical bounty submissions on candidate marketplaces are actually
   deterministic-replayable or statistically spot-checkable, versus open-ended/subjective?
2. Will marketplace operators accept a bonded, potentially-permissionless Re-executor network, or
   will they insist on a permissioned bootstrap set for Phase 1 (likely, given nascency)?
3. What does Stellar 8004's governance process look like for recognizing a new attestor type —
   is there a defined path, or is this ad hoc / relationship-based today?
4. Does ZKML-Soroban have a public roadmap or funding for completing step 4 (Groth16 compression)
   that Verity's Phase 2 gate should track directly, e.g. via a standing relationship with that
   team?
5. Is "Verity" available as a name, given the existing (unrelated, small) `AgentVeritas` project —
   avoid confusable branding in the same narrow niche.

---

## 17. Verified technical facts this PRD depends on

> *Research snapshot: these facts and sources reflect the 2026-09-16 research date and are preserved as written.*

| Fact | Status | Source |
|---|---|---|
| ZKML-Soroban: pipeline steps 1–3 and 5 implemented; Groth16 compression (step 4) and ONNX CLI ingestion pending; no production on-chain proof verified yet | VERIFIED | github.com/ZKML-Soroban/ZKML-Soroban (README/status table) |
| ZK-ML field-wide bottlenecks: "limited circuit expressiveness, high proving cost, and deployment complexity" | VERIFIED | arXiv:2502.18535 (2026 peer-reviewed survey) |
| VeriLLM: ZK-SNARK proving for transformer-scale inference is "orders of magnitude higher" cost than native inference; benchmarks ~2,646s/token (LLaMA-2-7B), 986s+803s (LLaMA-2-13B); VeriLLM's own re-derivation approach reduces verification cost to ~1% of inference cost | VERIFIED | arXiv:2509.24257 |
| Full end-to-end ZK-ML proof generation can take hours to weeks for a single inference | VERIFIED | Springer, 10.1007/s44443-026-00573-1 (Feb 2026) |
| zk-OPML: peer-reviewed (accepted Feb 2026), hybrid ZK/optimistic approach using selective operator-level ZK proofs | VERIFIED | zk-OPML paper (2026) |
| NanoZK: constant-size per-layer proofs (3.5–3.7KB/layer, ~83KB total for 12 layers) vs. prior monolithic ZKML proofs (101–126KB); production-scale transformer-block figure (d=768) is an extrapolated projection, directly measured only to d=128 | VERIFIED | arXiv:2603.18046 |
| Existing general ZK proof systems (Groth16, Gemini, Winterfell, Halo2, Plonky2, zkCNN) do not yet meet the production performance bar for ML inference verification | VERIFIED | Modulus Labs, eprint.iacr.org/2026/1063 |
| Stellar 8004: 3 Soroban contracts (identity, reputation, Validation registry); Validation Registry lets third parties attest to agent behavior; hackathon-built, not an official SDF standard | VERIFIED | developers.stellar.org/meetings/2026/04/23 |
| AgentVeritas: small, early-stage, testnet-only (1 star, 0 forks, 5 commits); non-cryptographic rule-based static analysis approach | VERIFIED | github.com/furkan3152/agentveritas-stellar |
| StellAIverse `OracleBridge`: verifies via signed attestations from a whitelisted "approved oracles" set, not proof of computation | VERIFIED | github.com/StellAIverse/StellAIverse-contracts |
| `sap-lyart.vercel.app` "Multi-Agent ZK Consensus" claim was checked and refuted (0-3 adversarial vote); no evidence of a working system | VERIFIED | sap-lyart.vercel.app (claim), adversarial verification round, 2026-09-16 |
| Stellar Agents hackathon: large builder ecosystem (260+ projects reported) around x402/MPP/Stripe-style agent payment and coordination tooling | VERIFIED | dorahacks.io/hackathon/stellar-agents-x402-stripe-mpp/detail |
| SCF #37 "AI Agent Toolkit: Soroban to MCP" awarded $108.0K, in Build phase | VERIFIED | communityfund.stellar.org/project/stellar-ai-agent-kit-mr6 |

[^ext-prds]: Cross-references from the 2026-09-16 Stellar AI-agent research series (frontier 7.4 multi-agent coalitions and frontier 7.5 underwriting manifests). Those separate research drafts are not part of this repository.
