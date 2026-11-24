import "../config/net.js";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { Client as EscrowGateClient } from "escrow-gate";

/**
 * Real, end-to-end proof that the whole system works against Stellar
 * testnet: SEP-10 login, artifact upload, a real submit(), real
 * reexecutor-agent processes replaying and attesting on-chain, the indexer
 * reconciling it, the keeper finalizing/resolving/settling. Nothing here is
 * mocked, and this script never attests on a fleet re-executor's behalf — it
 * plays the agent, the challenger, and (in one scenario) a separate rogue
 * re-executor that casts a deliberately wrong vote with its own stake.
 *
 * Every submission it makes is a real on-chain record, so it refuses to run
 * against anything but a local backend on the deployment scripts/smoke.sh
 * resolved (never one marked public).
 *
 * Profiles (SMOKE_PROFILE):
 *   quorum       default. Needs at least quorum re-executors online.
 *   underquorum  Needs FEWER than quorum online (start the stack with e.g.
 *                VERITY_REEXECUTORS="rex1 rex2"). Proves what happens when a
 *                window closes without consensus; waits out real windows.
 *
 *   SMOKE_AGENT_SECRET, SMOKE_CHALLENGER_SECRET   funded testnet accounts
 *   SMOKE_ROGUE_SECRET        staked + approved re-executor nobody runs a worker for
 *   SMOKE_EXPECT_CONTRACT_ID  the contract the backend must be serving
 *   SMOKE_ONLY                optional comma-separated scenario names
 *   SMOKE_SLOW=1              also wait out a real challenge window in the
 *                             quorum profile (adds one full window)
 */

const BASE = process.env.SMOKE_BACKEND_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3001}`;
const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PROFILE = process.env.SMOKE_PROFILE ?? "quorum";
const SLOW = process.env.SMOKE_SLOW === "1";
const XLM = 10_000_000n;

interface GateConfig {
  network_passphrase: string;
  escrow_gate_contract_id: string;
  quorum_min_reexecutors: number;
  reexecutor_slash_bps: number;
  window_tier_small_s: number;
}
let cfg: GateConfig;

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T = any>(path: string, opts: { token?: string; body?: unknown; method?: string } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data as T;
}

async function login(keypair: Keypair): Promise<string> {
  const { transaction } = await call(`/auth?account=${keypair.publicKey()}`);
  const tx = TransactionBuilder.fromXDR(transaction, cfg.network_passphrase);
  tx.sign(keypair);
  const { token } = await call("/auth", { body: { transaction: tx.toXDR() } });
  return token;
}

function sign(unsignedXdr: string, keypair: Keypair): string {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, cfg.network_passphrase);
  tx.sign(keypair);
  return tx.toXDR();
}

async function upload(token: string, content: string): Promise<{ content_hash: string; storage_ref: string }> {
  return call("/v1/artifacts", { token, body: { content_base64: Buffer.from(content).toString("base64") } });
}

interface Actor {
  keypair: Keypair;
  token: string;
}

interface Submitted {
  id: string;
  chainId: string;
}

async function submit(
  agent: Actor,
  name: string,
  task:
    | { type: "deterministic"; functionSource: string; input: unknown; claimedOutput: unknown }
    | { type: "retrieval"; spec: { url: string; pointer?: string }; claimedOutput: unknown }
): Promise<Submitted> {
  const inputJson = canonicalJson(task.type === "deterministic" ? task.input : task.spec);
  const input = await upload(agent.token, inputJson);
  const outputJson = canonicalJson(task.claimedOutput);
  const output = await upload(agent.token, outputJson);
  const fn = task.type === "deterministic" ? await upload(agent.token, task.functionSource) : null;

  const key = `smoke-${name}-${Date.now()}`;
  const created = await call("/v1/submissions", {
    token: agent.token,
    body: {
      escrow_ref: key,
      task_type: task.type,
      input_hash: input.content_hash,
      input_ref: input.storage_ref,
      claimed_output_hash: output.content_hash,
      claimed_output_ref: output.storage_ref,
      function_hash: fn?.content_hash,
      function_ref: fn?.storage_ref,
      escrow_value: String(100n * XLM),
      bond_amount: String(5n * XLM),
      idempotency_key: key,
    },
  });
  const relayed = await call(`/v1/submissions/${created.submission.id}/relay`, {
    token: agent.token,
    body: { signed_transaction_xdr: sign(created.unsigned_transaction_xdr, agent.keypair) },
  });
  console.log(`  submit() tx ${relayed.tx_hash} -> on-chain submission #${relayed.submission.chain_submission_id}`);
  return { id: created.submission.id as string, chainId: relayed.submission.chain_submission_id as string };
}

async function waitFor<T>(what: string, timeoutS: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(3000);
  }
  throw new Error(`timed out after ${timeoutS}s waiting for: ${what}`);
}

const detail = (id: string) => call(`/v1/submissions/${id}`);
const TERMINAL = ["verified", "slashed", "expired_unverified"];

/** Waits for a terminal verdict and its settlement, and checks both the
 * verdict and — just as important — how the contract says it was reached. */
async function expectVerdict(
  id: string,
  expected: "verified" | "slashed" | "expired_unverified",
  method: "reexecution_consensus" | "window_elapsed",
  timeoutS = 180
) {
  const d = await waitFor(`terminal verdict on ${id}`, timeoutS, async () => {
    const cur = await detail(id);
    return TERMINAL.includes(cur.submission.status) ? cur : null;
  });
  if (d.submission.status !== expected) throw new Error(`expected ${expected}, got ${d.submission.status}`);
  // Settlement waits for the indexer to have recorded every on-chain vote,
  // so the tally printed here is the complete one.
  const settled = await waitFor(`settlement (attestation locks released) on ${id}`, 180, async () => {
    const cur = await detail(id);
    return cur.submission.settled_at ? cur : null;
  });
  if (settled.submission.resolution_method !== method) {
    throw new Error(`expected the verdict to be recorded as ${method}, got ${settled.submission.resolution_method}`);
  }
  const votes = settled.replays.filter((r: any) => r.status === "confirmed_onchain");
  console.log(
    `  verdict=${expected} via ${method} with ${votes.length} on-chain attestation(s): ${votes.map((r: any) => (r.match ? "match" : "mismatch")).join(", ") || "none"}`
  );
  console.log("  settled: re-executor attestation locks released on-chain");
  await expectSignedAttestation(id, expected, method);
  return settled;
}

/** The attestation is only worth something if the signature really verifies
 * against the bytes the API says were signed. */
async function expectSignedAttestation(id: string, verdict: string, method: string) {
  const att = await call(`/v1/submissions/${id}/attestation`);
  const ok = Keypair.fromPublicKey(att.signer).verify(Buffer.from(att.canonical), Buffer.from(att.signature, "base64"));
  if (!ok) throw new Error("attestation signature does not verify against its canonical payload");
  if (att.payload.claim.verdict !== verdict || att.payload.claim.resolution_method !== method) {
    throw new Error(`attestation claims ${att.payload.claim.verdict}/${att.payload.claim.resolution_method}, expected ${verdict}/${method}`);
  }
  if (att.delivered_to !== null) throw new Error(`attestation claims delivery to ${att.delivered_to}; nothing is delivered anywhere`);
  console.log(`  attestation: ed25519 signature by ${att.signer.slice(0, 8)}… verifies`);
}

/** No vote on this submission may have been slashed. */
function expectNobodySlashed(d: any) {
  const slashed = d.replays.filter((r: any) => r.slash_tx_hash);
  if (slashed.length > 0) throw new Error(`${slashed.length} re-executor(s) were slashed on a verdict that proves nobody wrong`);
  console.log("  nobody slashed");
}

const DOUBLE = "return { doubled: input.n * 2, source: 'replay' };";

/** A scenario does its on-chain work (sequentially: every transaction it
 * signs shares an account sequence with the others) and may return the part
 * that only waits and checks. Those parts run together afterwards, so three
 * scenarios that each wait out a challenge window take one window, not three. */
type Scenario = (ctx: { agent: Actor; challenger: Actor; rogue: Actor | null }) => Promise<void | (() => Promise<void>)>;

/** Runs with at least a quorum of re-executors online. */
const quorumScenarios: Record<string, Scenario> = {
  async "honest-deterministic"({ agent }) {
    const { id } = await submit(agent, "honest", {
      type: "deterministic",
      functionSource: DOUBLE,
      input: { n: 21 },
      // Key order deliberately differs from the function's — canonical
      // hashing must make that irrelevant.
      claimedOutput: { source: "replay", doubled: 42 },
    });
    expectNobodySlashed(await expectVerdict(id, "verified", "reexecution_consensus"));
  },

  async "dishonest-deterministic"({ agent }) {
    const { id } = await submit(agent, "dishonest", {
      type: "deterministic",
      functionSource: DOUBLE,
      input: { n: 21 },
      claimedOutput: { source: "replay", doubled: 9000 },
    });
    expectNobodySlashed(await expectVerdict(id, "slashed", "reexecution_consensus"));
  },

  async "challenged-honest"({ agent, challenger }) {
    const { id } = await submit(agent, "challenged", {
      type: "deterministic",
      functionSource: DOUBLE,
      input: { n: 4 },
      claimedOutput: { doubled: 8, source: "replay" },
    });
    const built = await call(`/v1/submissions/${id}/challenge`, {
      token: challenger.token,
      body: { bond: String(5n * XLM) },
    });
    const relayed = await call(`/v1/submissions/${id}/challenge/relay`, {
      token: challenger.token,
      body: { signed_transaction_xdr: sign(built.unsigned_transaction_xdr, challenger.keypair) },
    });
    console.log(`  open_challenge() tx ${relayed.tx_hash}`);
    await waitFor("indexer to record the challenge", 60, async () => (await detail(id)).challenge);
    await expectVerdict(id, "verified", "reexecution_consensus");
    const challenge = (await detail(id)).challenge;
    console.log(`  challenge resolution=${challenge.resolution} via ${challenge.resolution_method}`);
    if (challenge.resolution !== "rejected") throw new Error(`expected challenge rejected, got ${challenge.resolution}`);
  },

  async "relay-refuses-foreign-transaction"({ agent, challenger }) {
    // The challenge relay must forward the caller's own open_challenge on
    // that submission and nothing else. Hand it a different, validly signed
    // EscrowGate call and it has to refuse before anything is broadcast.
    const first = await submit(agent, "relay-a", {
      type: "deterministic",
      functionSource: DOUBLE,
      input: { n: 1 },
      claimedOutput: { doubled: 2, source: "replay" },
    });
    const second = await submit(agent, "relay-b", {
      type: "deterministic",
      functionSource: DOUBLE,
      input: { n: 2 },
      claimedOutput: { doubled: 4, source: "replay" },
    });
    const builtForSecond = await call(`/v1/submissions/${second.id}/challenge`, {
      token: challenger.token,
      body: { bond: String(5n * XLM) },
    });
    const res = await fetch(`${BASE}/v1/submissions/${first.id}/challenge/relay`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${challenger.token}` },
      body: JSON.stringify({ signed_transaction_xdr: sign(builtForSecond.unsigned_transaction_xdr, challenger.keypair) }),
    });
    if (res.status !== 400) throw new Error(`expected the relay to refuse with 400, got ${res.status}`);
    console.log(`  refused: ${(await res.json()).error}`);
    if ((await detail(second.id)).challenge) throw new Error("the refused transaction was broadcast anyway");
  },

  async "honest-retrieval"({ agent }) {
    const { id } = await submit(agent, "retrieval-ok", {
      type: "retrieval",
      spec: { url: "https://horizon-testnet.stellar.org/", pointer: "/network_passphrase" },
      claimedOutput: cfg.network_passphrase,
    });
    const check = await waitFor("spot-check result", 120, async () => {
      const d = await detail(id);
      return d.spot_checks.find((s: any) => s.result) ?? null;
    });
    console.log(`  spot-check result=${check.result} (sampled re-executor re-fetched the endpoint and attested on-chain)`);
    if (check.result !== "match") throw new Error(`expected spot-check match, got ${check.result}`);
    const d = await detail(id);
    if (d.submission.status !== "pending") throw new Error(`expected pending, got ${d.submission.status}`);
    // One sampled vote is not a quorum, so this is verified optimistically
    // when its window closes — and must be recorded as exactly that.
    if (!SLOW) {
      console.log(`  status=pending — optimistic: verifies when its ${d.submission.challenge_window_s}s window closes (SMOKE_SLOW=1 waits for it)`);
      return;
    }
    console.log(`  waiting out the ${d.submission.challenge_window_s}s challenge window…`);
    expectNobodySlashed(await expectVerdict(id, "verified", "window_elapsed", d.submission.challenge_window_s + 180));
  },

  async "dishonest-retrieval"({ agent }) {
    const { id } = await submit(agent, "retrieval-bad", {
      type: "retrieval",
      spec: { url: "https://horizon-testnet.stellar.org/", pointer: "/network_passphrase" },
      claimedOutput: "a fabricated answer the agent never retrieved",
    });
    const d = await expectVerdict(id, "slashed", "reexecution_consensus");
    const check = d.spot_checks.find((s: any) => s.result);
    console.log(`  spot-check result=${check?.result} -> escalated to a full replay quorum`);
    if (check?.result !== "mismatch") throw new Error("expected a spot-check mismatch to have triggered the escalation");
  },

  async "wrong-vote-is-slashed-then-withdraws"({ agent, rogue }) {
    if (!rogue) throw new Error("SMOKE_ROGUE_SECRET is not set (scripts/smoke.sh stakes and approves the rogue identity)");
    const account = rogue.keypair.publicKey();
    const { reexecutor: before } = await call("/v1/reexecutors/sync", { token: rogue.token, method: "POST" });
    const gate = new EscrowGateClient({
      contractId: cfg.escrow_gate_contract_id,
      networkPassphrase: cfg.network_passphrase,
      rpcUrl: RPC_URL,
      publicKey: account,
      ...basicNodeSigner(rogue.keypair, cfg.network_passphrase),
    });

    // The rogue has to get its vote on-chain before the fleet's consensus
    // finalizes the submission, so a lost race is simply run again.
    let submitted: Submitted | null = null;
    for (let attempt = 1; attempt <= 3 && !submitted; attempt++) {
      const candidate = await submit(agent, `rogue-${attempt}`, {
        type: "deterministic",
        functionSource: DOUBLE,
        input: { n: 10 + attempt },
        claimedOutput: { doubled: 2 * (10 + attempt), source: "replay" },
      });
      try {
        const tx = await gate.attest_replay({
          reexecutor: account,
          submission_id: BigInt(candidate.chainId),
          output_hash: Buffer.alloc(32),
          matched: false, // a real vote, and wrong: the work is honest
        });
        const sent = await tx.signAndSend();
        sent.result.unwrap();
        console.log(`  rogue ${account.slice(0, 8)}… voted mismatch on honest work: tx ${sent.sendTransactionResponse?.hash}`);
        submitted = candidate;
      } catch (err) {
        if (!/Error\(Contract, #32\)/.test((err as Error).message)) throw err;
        console.log("  the fleet finalized before the rogue's vote landed; trying again");
      }
    }
    if (!submitted) throw new Error("the rogue never out-raced the fleet in 3 attempts");

    const settled = await expectVerdict(submitted.id, "verified", "reexecution_consensus");
    const slashedVote = await waitFor("the rogue's slash to be indexed", 120, async () => {
      const d = await detail(submitted!.id);
      return d.replays.find((r: any) => r.reexecutor_account === account && r.slash_tx_hash) ?? null;
    });
    const others = settled.replays.filter((r: any) => r.reexecutor_account !== account && r.slash_tx_hash);
    if (others.length > 0) throw new Error("an honest re-executor was slashed");

    const afterSlash = (await call(`/v1/reexecutors/${before.id}`)).reexecutor;
    const expected = (BigInt(before.stake_amount) * BigInt(cfg.reexecutor_slash_bps)) / 10000n;
    const lost = BigInt(before.stake_amount) - BigInt(afterSlash.stake_amount);
    if (lost !== expected) throw new Error(`expected exactly ${expected} stroops slashed (the on-chain rate), stake fell by ${lost}`);
    console.log(`  slashed ${lost} stroops (${cfg.reexecutor_slash_bps} bps of stake) in tx ${slashedVote.slash_tx_hash}; honest voters untouched`);

    // And the rest of the lifecycle: the lock is released, so stake can leave.
    const built = await call(`/v1/reexecutors/${before.id}/withdraw`, { token: rogue.token, body: { amount: String(XLM) } });
    const relayed = await call(`/v1/reexecutors/${before.id}/relay`, {
      token: rogue.token,
      body: { signed_transaction_xdr: sign(built.unsigned_transaction_xdr, rogue.keypair) },
    });
    const withdrawn = BigInt(afterSlash.stake_amount) - BigInt(relayed.reexecutor.stake_amount);
    if (withdrawn !== XLM) throw new Error(`expected a 1 XLM withdrawal, stake fell by ${withdrawn}`);
    console.log(`  withdrew 1 XLM of stake: tx ${relayed.tx_hash}`);
  },
};

/** Runs with FEWER than a quorum online, so no consensus can ever form. */
const underQuorumScenarios: Record<string, Scenario> = {
  async "unreplayed-honest-defaults-verified"({ agent }) {
    const { id } = await submit(agent, "uq-honest", {
      type: "deterministic",
      functionSource: DOUBLE,
      input: { n: 3 },
      claimedOutput: { doubled: 6, source: "replay" },
    });
    console.log(`  submitted; its ${cfg.window_tier_small_s}s challenge window has to close with no quorum`);
    // Verified by default, and said to be exactly that — not a consensus.
    return async () => {
      expectNobodySlashed(await expectVerdict(id, "verified", "window_elapsed", cfg.window_tier_small_s + 300));
    };
  },

  async "contested-without-quorum-expires"({ agent }) {
    const { id } = await submit(agent, "uq-dishonest", {
      type: "deterministic",
      functionSource: DOUBLE,
      input: { n: 3 },
      claimedOutput: { doubled: 999, source: "replay" },
    });
    console.log(`  submitted; its ${cfg.window_tier_small_s}s window has to close with mismatch votes but no quorum`);
    // Re-executors reported a mismatch but could not reach quorum: the work
    // is neither verified nor slashed, and the honest voters keep their stake.
    return async () => {
      const d = await expectVerdict(id, "expired_unverified", "window_elapsed", cfg.window_tier_small_s + 300);
      expectNobodySlashed(d);
      if (!d.replays.some((r: any) => r.status === "confirmed_onchain" && r.match === false)) {
        throw new Error("expected at least one on-chain mismatch vote behind the expiry");
      }
    };
  },

  async "unresolved-challenge-expires"({ agent, challenger }) {
    const { id } = await submit(agent, "uq-challenged", {
      type: "deterministic",
      functionSource: DOUBLE,
      input: { n: 5 },
      claimedOutput: { doubled: 10, source: "replay" },
    });
    const built = await call(`/v1/submissions/${id}/challenge`, {
      token: challenger.token,
      body: { bond: String(5n * XLM) },
    });
    await call(`/v1/submissions/${id}/challenge/relay`, {
      token: challenger.token,
      body: { signed_transaction_xdr: sign(built.unsigned_transaction_xdr, challenger.keypair) },
    });
    await waitFor("indexer to record the challenge", 60, async () => (await detail(id)).challenge);
    console.log(`  challenge open; it has to expire unresolved ${cfg.window_tier_small_s}s after it was opened`);
    return async () => {
      const d = await expectVerdict(id, "expired_unverified", "window_elapsed", cfg.window_tier_small_s + 360);
      expectNobodySlashed(d);
      if (!d.challenge.resolved_at || d.challenge.resolution !== "expired") {
        throw new Error(`expected the challenge to be closed as expired, got resolution=${d.challenge.resolution}`);
      }
    };
  },
};

async function main() {
  const host = new URL(BASE).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`refusing to run against ${BASE}: the smoke test writes real test submissions and only targets a local backend`);
  }
  const health = await call("/health");
  const expectedContract = process.env.SMOKE_EXPECT_CONTRACT_ID;
  if (!expectedContract) {
    throw new Error("SMOKE_EXPECT_CONTRACT_ID is required (scripts/smoke.sh sets it from the deployment it resolved)");
  }
  if (health.escrow_gate_contract_id !== expectedContract) {
    throw new Error(
      `refusing to run: the backend at ${BASE} serves contract ${health.escrow_gate_contract_id} (deployment '${health.deployment}'), not ${expectedContract}`
    );
  }
  cfg = await call("/v1/config");

  const agentSecret = process.env.SMOKE_AGENT_SECRET;
  const challengerSecret = process.env.SMOKE_CHALLENGER_SECRET;
  if (!agentSecret || !challengerSecret) {
    throw new Error("SMOKE_AGENT_SECRET and SMOKE_CHALLENGER_SECRET are required (scripts/smoke.sh sets them from your stellar-cli identities)");
  }
  const actor = async (secret: string): Promise<Actor> => {
    const keypair = Keypair.fromSecret(secret);
    return { keypair, token: await login(keypair) };
  };
  const agent = await actor(agentSecret);
  const challenger = await actor(challengerSecret);
  const rogue = process.env.SMOKE_ROGUE_SECRET ? await actor(process.env.SMOKE_ROGUE_SECRET) : null;
  console.log(`[smoke] backend    ${BASE} (deployment '${health.deployment}', contract ${expectedContract})`);
  console.log(`[smoke] agent      ${agent.keypair.publicKey()}`);
  console.log(`[smoke] challenger ${challenger.keypair.publicKey()}`);
  if (rogue) console.log(`[smoke] rogue      ${rogue.keypair.publicKey()}`);

  // The rogue is staked and approved but runs no worker, so it is never
  // online — it does not count toward (or against) either profile.
  const working = ((await call("/v1/reexecutors")) as any[]).filter((r) => r.can_vote && r.online);
  console.log(`[smoke] ${working.length} re-executor(s) online and able to vote; quorum is ${cfg.quorum_min_reexecutors}; profile '${PROFILE}'`);
  let scenarios: Record<string, Scenario>;
  if (PROFILE === "quorum") {
    if (working.length < cfg.quorum_min_reexecutors) {
      throw new Error(`need at least ${cfg.quorum_min_reexecutors} re-executors online — is \`pnpm dev\` running with its agents?`);
    }
    scenarios = quorumScenarios;
  } else if (PROFILE === "underquorum") {
    if (working.length === 0 || working.length >= cfg.quorum_min_reexecutors) {
      throw new Error(`the underquorum profile needs between 1 and ${cfg.quorum_min_reexecutors - 1} re-executors online (start the stack with e.g. VERITY_REEXECUTORS="rex1 rex2"); ${working.length} are`);
    }
    scenarios = underQuorumScenarios;
  } else {
    throw new Error(`unknown SMOKE_PROFILE '${PROFILE}' (quorum | underquorum)`);
  }

  const only = (process.env.SMOKE_ONLY ?? "").split(",").filter(Boolean);
  const results: Array<{ name: string; ok: boolean; error?: string }> = [];
  const waiting: Array<{ name: string; finish: () => Promise<void> }> = [];
  for (const [name, run] of Object.entries(scenarios)) {
    if (only.length > 0 && !only.includes(name)) continue;
    console.log(`\n[smoke] scenario: ${name}`);
    try {
      const finish = await run({ agent, challenger, rogue });
      if (finish) {
        waiting.push({ name, finish });
        continue;
      }
      results.push({ name, ok: true });
      console.log("  PASS");
    } catch (err) {
      results.push({ name, ok: false, error: (err as Error).message });
      console.error(`  FAIL: ${(err as Error).message}`);
    }
  }
  if (waiting.length > 0) {
    console.log(`\n[smoke] waiting on ${waiting.length} scenario(s) whose challenge windows have to close…`);
    await Promise.all(
      waiting.map(async ({ name, finish }) => {
        try {
          await finish();
          results.push({ name, ok: true });
          console.log(`  PASS  ${name}`);
        } catch (err) {
          results.push({ name, ok: false, error: (err as Error).message });
          console.error(`  FAIL  ${name}: ${(err as Error).message}`);
        }
      })
    );
  }

  console.log("\n=== SMOKE TEST RESULT ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.error ? `  — ${r.error}` : ""}`);
  if (results.length === 0) throw new Error("no scenario matched SMOKE_ONLY");
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((err) => {
  console.error("[smoke] FAILED:", err);
  process.exit(1);
});
