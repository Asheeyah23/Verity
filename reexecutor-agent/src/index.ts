import "dotenv/config";
import "./net.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { Client as EscrowGateClient } from "escrow-gate";
import type { SubmissionRecord } from "escrow-gate";
import { REPLAY_ENGINE, ReplayInfrastructureError, runDeterministicFunction } from "./sandbox/runner.js";
import {
  decideRetrievalTargetUnreachable,
  defaultInternetCheckUrl,
  RetrievalTransientError,
  runRetrieval,
  warnIfProbePrivateAndNoInternet,
} from "./sandbox/retrieval.js";
import {
  isInsecureBackendUrl,
  resolveSep10ServerConfig,
  verifySep10Challenge,
  type Sep10ServerConfig,
} from "./sep10.js";
import { NO_OUTPUT_HASH, voteMatches } from "./vote.js";
import { startHeartbeat, type Heartbeat } from "./heartbeat.js";
import { findConfigMismatches, type BackendConfig } from "./config.js";

const DEFAULT_VOTING_BLOCK_MS = 60_000;
const DEFAULT_RESYNC_COOLDOWN_MS = 60_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[reexecutor-agent] ${name} is required (see reexecutor-agent/.env.example)`);
    process.exit(1);
  }
  return value;
}

/** Reads the signing key from REEXECUTOR_SECRET_KEY or from the file named by
 * REEXECUTOR_SECRET_KEY_FILE (trimmed), so container deployments can mount a
 * secret file instead of exposing the key in `docker inspect` or process.env.
 * Refuses to start when both are set, when neither is set, or when the file is
 * unreadable or empty. */
function secretKeyEnv(): string {
  const fromEnv = process.env.REEXECUTOR_SECRET_KEY;
  const fromFile = process.env.REEXECUTOR_SECRET_KEY_FILE;
  const hasEnv = fromEnv !== undefined && fromEnv !== "";
  const hasFile = fromFile !== undefined && fromFile !== "";
  if (hasEnv && hasFile) {
    console.error("[reexecutor-agent] set either REEXECUTOR_SECRET_KEY or REEXECUTOR_SECRET_KEY_FILE, not both");
    process.exit(1);
  }
  if (hasFile) {
    const filePath = fromFile.trim();
    let key: string;
    try {
      key = readFileSync(filePath, "utf8").trim();
    } catch (err) {
      console.error(
        `[reexecutor-agent] failed to read REEXECUTOR_SECRET_KEY_FILE (${filePath}): ${(err as Error).message}`
      );
      process.exit(1);
    }
    if (!key) {
      console.error(`[reexecutor-agent] REEXECUTOR_SECRET_KEY_FILE (${filePath}) is empty`);
      process.exit(1);
    }
    return key;
  }
  const key = fromEnv?.trim();
  if (key) return key;
  console.error(
    "[reexecutor-agent] REEXECUTOR_SECRET_KEY or REEXECUTOR_SECRET_KEY_FILE is required (see reexecutor-agent/.env.example)"
  );
  process.exit(1);
}

/** A numeric setting: unset or empty uses `fallback`; anything else must be a
 * finite number >= `min`, or the agent refuses to start. A bare `Number(...)`
 * turned a typo into NaN, i.e. a 1 ms poll loop or no retrieval retry wait. */
export function numberEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    console.error(`[reexecutor-agent] ${name} must be a number >= ${min} (got "${raw}")`);
    process.exit(1);
  }
  return value;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** True when the backend rejected a request with 403 or 404 — meaning this
 * worker's cached `reexecutor.id` row no longer exists on the backend (e.g.
 * after a database reset or redeploy). */
export function isNotRecognised(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (status === 403 || status === 404) return true;
  }
  if (err instanceof Error) {
    return /(?:\bHTTP\s+|->\s*|\bstatus\s*[:=]?\s*|^)(403|404)\b/.test(err.message);
  }
  return false;
}

export type ApiFn = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

export interface Assignment {
  function_ref: string | null;
  input_ref: string | null;
  chain_submission_id: string;
}

export interface ReexecutorSyncRow {
  id: string;
  active: boolean;
  approved: boolean;
  stake_amount: string;
}

export type SubmissionLike = Pick<
  SubmissionRecord,
  "finalized" | "task_type" | "claimed_output_hash" | "input_hash" | "challenge_window_s" | "submitted_at"
>;

export interface EscrowGateLike {
  get_submission: (args: { id: bigint }) => Promise<{ result: SubmissionLike | undefined | null }>;
  attest_replay: (args: {
    reexecutor: string;
    submission_id: bigint;
    output_hash: Buffer;
    matched: boolean;
  }) => Promise<{
    signAndSend: () => Promise<{
      result?: { unwrap?: () => unknown };
      sendTransactionResponse?: { hash?: string };
    }>;
  }>;
}

export interface WorkerOptions {
  api: ApiFn;
  client: EscrowGateLike;
  publicKey: string;
  initialReexecutorId?: string;
  heartbeatIntervalMs?: number;
  votingBlockMs?: number;
  resyncCooldownMs?: number;
  retrievalRetryBudgetS?: number;
  connectivityCheckUrl?: string;
  /** Public endpoint that proves internet access when `connectivityCheckUrl` is a private address. */
  internetCheckUrl?: string;
  now?: () => number;
  reExecute?: (a: Assignment, record: SubmissionLike) => Promise<{ outputHash: string; engine: string }>;
}

export interface ReexecutorWorker {
  readonly reexecutorId: string;
  readonly votingBlockedUntil: number;
  sync: () => Promise<ReexecutorSyncRow>;
  resync: () => Promise<ReexecutorSyncRow | null>;
  pollOnce: () => Promise<void>;
  beat: () => Promise<void>;
  startHeartbeat: () => Heartbeat;
  stop: () => void;
}

const noOutput = (why: string) => ({ outputHash: NO_OUTPUT_HASH, engine: why });

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export function createWorker(options: WorkerOptions): ReexecutorWorker {
  const {
    api,
    client,
    publicKey,
    heartbeatIntervalMs = 15_000,
    votingBlockMs = DEFAULT_VOTING_BLOCK_MS,
    resyncCooldownMs = DEFAULT_RESYNC_COOLDOWN_MS,
    retrievalRetryBudgetS = 120,
    connectivityCheckUrl = process.env.CONNECTIVITY_CHECK_URL ?? process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
    internetCheckUrl = process.env.INTERNET_CHECK_URL ??
      defaultInternetCheckUrl(process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015"),
    now = Date.now,
  } = options;
  const usesRealClock = options.now === undefined;
  const tag = `[reexecutor ${publicKey.slice(0, 8)}]`;

  let reexecutorId = options.initialReexecutorId ?? "";
  let lastResyncAt: number | null = null;
  let resyncInFlight: Promise<ReexecutorSyncRow | null> | null = null;

  /** Submissions this process has already voted on. The backend keeps listing
   * an assignment until its indexer sees our ReplayAttested event a few
   * seconds later; without this we would re-run and re-send in the meantime.
   * Entries live only while the backend still lists the assignment (see
   * `pruneToListed`). */
  const attested = new Set<string>();

  /** When this process first failed to reach a submission's retrieval target.
   * Entries live only while the backend still lists the assignment (see
   * `pruneToListed`). */
  const firstUnreachableAt = new Map<string, number>();

  /** Set when the contract says this account may not vote at all (stake below
   * the floor, or not approved). Replaying is pointless until that changes, so
   * work and liveness reporting are paused for a while instead of being retried
   * every poll. */
  let votingBlockedUntil = 0;
  let blockTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: Heartbeat | null = null;

  function clearBlockTimer() {
    if (blockTimer !== null) {
      clearTimeout(blockTimer);
      blockTimer = null;
    }
  }

  function scheduleHeartbeatResume(delayMs: number) {
    clearBlockTimer();
    if (heartbeat === null) return;
    blockTimer = setTimeout(() => {
      blockTimer = null;
      if (usesRealClock || now() >= votingBlockedUntil) {
        votingBlockedUntil = 0;
        heartbeat?.start();
      } else {
        scheduleHeartbeatResume(Math.max(1, votingBlockedUntil - now()));
      }
    }, Math.max(0, delayMs));
    blockTimer.unref();
  }

  function blockVoting() {
    votingBlockedUntil = now() + votingBlockMs;
    heartbeat?.stop();
    scheduleHeartbeatResume(votingBlockMs);
  }

  async function sync(): Promise<ReexecutorSyncRow> {
    const { reexecutor } = await api<{
      reexecutor: ReexecutorSyncRow;
    }>("/v1/reexecutors/sync", { method: "POST" });
    reexecutorId = reexecutor.id;
    return reexecutor;
  }

  /** Rate-limited re-sync (at most once per `resyncCooldownMs`) triggered when
   * the assignments or heartbeat endpoint stops recognising `reexecutorId`. */
  async function resync(): Promise<ReexecutorSyncRow | null> {
    if (resyncInFlight) return resyncInFlight;
    const currentNow = now();
    if (lastResyncAt !== null && currentNow - lastResyncAt < resyncCooldownMs) {
      return null;
    }
    lastResyncAt = currentNow;
    resyncInFlight = sync().finally(() => {
      resyncInFlight = null;
    });
    return resyncInFlight;
  }

  async function fetchArtifact(ref: string): Promise<Buffer> {
    const contentHash = ref.split(/[\\/]/).pop()!;
    const { content_base64 } = await api<{ content_base64: string }>(`/v1/artifacts/${contentHash}`);
    return Buffer.from(content_base64, "base64");
  }

  /**
   * Re-derives the output from the submission's own declared artifacts.
   *
   * A vote is bonded and irreversible, so the line between two kinds of
   * failure is the whole job here:
   *  - the *submission's* fault (it throws, exceeds the sandbox's limits, its
   *    spec is malformed, its target answers differently) resolves to a
   *    mismatch — an agent must not dodge a slash by submitting work that
   *    cannot be replayed;
   *  - *this worker's* trouble (backend or network unreachable, sandbox could
   *    not run on this host) throws instead. Nothing is voted and the
   *    assignment is retried on the next poll.
   *
   * What the agent committed to is read from the contract, not from the
   * backend: the task type, and the hash the input must have.
   */
  async function defaultReExecute(
    a: Assignment,
    record: SubmissionLike
  ): Promise<{ outputHash: string; engine: string }> {
    if (!a.input_ref) return noOutput("none (no input artifact declared)");
    const inputBytes = await fetchArtifact(a.input_ref);
    if (createHash("sha256").update(inputBytes).digest("hex") !== hex(record.input_hash)) {
      // Not the agent's doing: the contract holds the right hash, the backend
      // handed over something else. Refuse to vote on the wrong input.
      throw new Error("backend served an input artifact that does not match the on-chain input_hash");
    }

    if (record.task_type.tag === "Retrieval") {
      let spec;
      try {
        spec = JSON.parse(inputBytes.toString("utf8"));
      } catch {
        return noOutput("retrieval failed: the request spec is not JSON");
      }
      try {
        return await runRetrieval(spec);
      } catch (err) {
        const message = (err as Error).message;
        if (!(err instanceof RetrievalTransientError)) return noOutput(`retrieval failed: ${message}`);

        const nowS = now() / 1000;
        const first = firstUnreachableAt.get(a.chain_submission_id) ?? nowS;
        firstUnreachableAt.set(a.chain_submission_id, first);
        const budget = Math.min(retrievalRetryBudgetS, Number(record.challenge_window_s) / 2);
        const giveUpAt = Math.max(Number(record.submitted_at), first) + budget;
        if (nowS < giveUpAt) {
          throw new Error(`retrieval inconclusive (${message}); retrying for another ${Math.ceil(giveUpAt - nowS)}s before judging`);
        }
        return await decideRetrievalTargetUnreachable({
          message,
          budget,
          connectivityUrl: connectivityCheckUrl,
          internetUrl: internetCheckUrl,
        });
      }
    }

    if (!a.function_ref) return noOutput("none (no function artifact declared)");
    const functionSource = (await fetchArtifact(a.function_ref)).toString("utf8");
    let input: unknown;
    try {
      input = JSON.parse(inputBytes.toString("utf8"));
    } catch {
      return noOutput("replay failed: the input artifact is not JSON");
    }
    try {
      return await runDeterministicFunction(functionSource, input);
    } catch (err) {
      if (err instanceof ReplayInfrastructureError) throw err;
      return noOutput(`replay failed: ${(err as Error).message}`);
    }
  }

  const reExecute = options.reExecute ?? defaultReExecute;

  async function processAssignment(a: Assignment) {
    if (attested.has(a.chain_submission_id)) return;
    const record = (await client.get_submission({ id: BigInt(a.chain_submission_id) })).result;
    if (!record) throw new Error("submission is not on-chain (yet)");
    if (record.finalized) {
      attested.add(a.chain_submission_id);
      firstUnreachableAt.delete(a.chain_submission_id);
      return;
    }

    console.log(`${tag} re-executing ${record.task_type.tag.toLowerCase()} submission #${a.chain_submission_id}`);
    const { outputHash, engine } = await reExecute(a, record);
    const claimed = hex(record.claimed_output_hash);
    const matched = voteMatches(outputHash, claimed);
    console.log(`${tag}   engine=${engine}`);
    console.log(`${tag}   output=${outputHash} claimed=${claimed} matched=${matched}`);

    try {
      const tx = await client.attest_replay({
        reexecutor: publicKey,
        submission_id: BigInt(a.chain_submission_id),
        output_hash: Buffer.from(outputHash, "hex"),
        matched,
      });
      const sent = await tx.signAndSend();
      sent.result?.unwrap?.();
      console.log(`${tag}   attest_replay tx: ${sent.sendTransactionResponse?.hash ?? "(confirmed)"}`);
    } catch (err) {
      const code = /Error\(Contract, #(\d+)\)/.exec((err as Error).message ?? "")?.[1];
      if (code === "20" || code === "27") {
        // #20 ReexecutorNotActive, #27 ReexecutorNotApproved.
        blockVoting();
        console.warn(
          `${tag}   EscrowGate refused the vote: this account is ${code === "20" ? "not active (stake below the floor)" : "not approved as a voter"}. Pausing work for 60s.`
        );
        await sync().catch((syncErr) =>
          console.warn(`${tag}   sync after vote refusal failed:`, (syncErr as Error).message)
        );
        return;
      }
      // #23 AlreadyAttested: our vote is already on-chain. #32 ChallengeWindowClosed:
      // the submission was finalized before we got to it, or its window closed
      // with no challenge open, after which the contract takes no more votes on
      // it. Either way there is nothing left for us to do for this submission,
      // and retrying would never succeed.
      if (code !== "23" && code !== "32") throw err;
      console.log(`${tag}   nothing to do (already attested, or too late to vote)`);
    }
    attested.add(a.chain_submission_id);
    firstUnreachableAt.delete(a.chain_submission_id);
  }

  /** Drops per-submission state for everything the backend no longer lists, so
   * a worker that runs for weeks only holds state for its current assignments.
   * Safe even if a pruned id is listed again later: `attest_replay` then fails
   * with #23 AlreadyAttested, which `processAssignment` already treats as
   * nothing to do, so the worst case is one redundant RPC call, never a second
   * vote. */
  function pruneToListed(listed: ReadonlySet<string>) {
    for (const id of attested) if (!listed.has(id)) attested.delete(id);
    for (const id of firstUnreachableAt.keys()) if (!listed.has(id)) firstUnreachableAt.delete(id);
  }

  async function pollOnce() {
    // While voting is blocked, skip the assignment poll as well as the
    // heartbeat so the backend does not keep refreshing last_seen_at and
    // handing quorum seats to a worker that cannot cast a vote.
    if (now() < votingBlockedUntil) return;
    clearBlockTimer();
    heartbeat?.start();

    if (!reexecutorId) {
      await sync();
    }

    let replay_assignments: Assignment[];
    let spot_check_assignments: Assignment[];
    try {
      ({ replay_assignments, spot_check_assignments } = await api<{
        replay_assignments: Assignment[];
        spot_check_assignments: Assignment[];
      }>(`/v1/reexecutors/${reexecutorId}/assignments`));
    } catch (err) {
      if (isNotRecognised(err)) {
        await resync();
        return;
      }
      throw err;
    }
    // Only after a successful fetch: if `api` throws, nothing is pruned.
    pruneToListed(new Set([...replay_assignments, ...spot_check_assignments].map((a) => a.chain_submission_id)));
    // A sampled spot-check and a full replay are the same job for the worker:
    // re-derive the output, then put a bonded vote on-chain.
    for (const assignment of [...replay_assignments, ...spot_check_assignments]) {
      if (now() < votingBlockedUntil) break;
      try {
        await processAssignment(assignment);
      } catch (err) {
        console.error(`${tag}   assignment #${assignment.chain_submission_id} failed, will retry:`, (err as Error).message);
      }
    }
  }

  async function beat(): Promise<void> {
    if (now() < votingBlockedUntil) return;
    if (!reexecutorId) {
      await resync();
      return;
    }
    try {
      await api<unknown>(`/v1/reexecutors/${reexecutorId}/heartbeat`, { method: "POST" });
    } catch (err) {
      if (isNotRecognised(err)) {
        await resync();
        return;
      }
      throw err;
    }
  }

  function ensureHeartbeat(): Heartbeat {
    if (heartbeat === null) {
      heartbeat = startHeartbeat(
        beat,
        heartbeatIntervalMs,
        (err) => console.warn(`${tag} heartbeat failed (the assignment poll still reports liveness):`, err.message)
      );
    }
    if (now() < votingBlockedUntil) {
      heartbeat.stop();
      scheduleHeartbeatResume(votingBlockedUntil - now());
    } else {
      heartbeat.start();
    }
    return heartbeat;
  }

  function stop() {
    clearBlockTimer();
    heartbeat?.stop();
    heartbeat = null;
  }

  return {
    get reexecutorId() {
      return reexecutorId;
    },
    get votingBlockedUntil() {
      return votingBlockedUntil;
    },
    sync,
    resync,
    pollOnce,
    beat,
    startHeartbeat: ensureHeartbeat,
    stop,
  };
}

async function verifyBackendConfig(backendUrl: string, contractId: string, networkPassphrase: string): Promise<void> {
  const res = await fetch(`${backendUrl}/v1/config`);
  if (!res.ok) throw new Error(`GET /v1/config failed: HTTP ${res.status}`);
  const remote: unknown = await res.json();
  if (!remote || typeof remote !== "object") {
    throw new Error("GET /v1/config returned an unexpected payload");
  }
  const mismatches = findConfigMismatches(
    { contractId, networkPassphrase },
    remote as BackendConfig
  );
  if (mismatches.length > 0) {
    console.error(`[reexecutor-agent] refusing to start: backend at ${backendUrl} does not match this worker's configuration:`);
    for (const mismatch of mismatches) {
      console.error(`[reexecutor-agent]   ${mismatch}`);
    }
    process.exit(1);
  }
}

async function main() {
  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:3001";
  const networkPassphrase = process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015";
  const rpcUrl = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
  const contractId = requireEnv("ESCROW_GATE_CONTRACT_ID");
  const pollMs = numberEnv("POLL_INTERVAL_MS", 3000, 250);
  /** Well inside the backend's REEXECUTOR_LIVENESS_S (default 60 s). */
  const heartbeatMs = numberEnv("HEARTBEAT_INTERVAL_MS", 15_000, 1000);
  // How long a retrieval target may stay unreachable before this worker
  // concludes it is the target's fault (never longer than half the window).
  const retrievalRetryBudgetS = numberEnv("RETRIEVAL_RETRY_BUDGET_S", 120, 1);
  // Any endpoint this worker must be able to reach anyway. If even this fails,
  // the problem is our network, and an unreachable target proves nothing.
  const connectivityCheckUrl = process.env.CONNECTIVITY_CHECK_URL || rpcUrl;
  // When CONNECTIVITY_CHECK_URL is a private address, this public endpoint must
  // be reachable to prove internet access before voting mismatch on an unreachable target.
  const internetCheckUrl = process.env.INTERNET_CHECK_URL || defaultInternetCheckUrl(networkPassphrase);
  const once = process.argv.includes("--once");
  // SEP-10 trust anchors. All three are optional: anything missing is
  // discovered once from the backend's /.well-known/stellar.toml at startup,
  // so pnpm dev and the compose fleet need no extra configuration. Set them to
  // pin the server instead of trusting the toml (see reexecutor-agent/.env.example).
  const sep10ServerKey = process.env.SEP10_SERVER_KEY;
  const sep10HomeDomain = process.env.SEP10_HOME_DOMAIN;
  const sep10WebAuthDomain = process.env.SEP10_WEB_AUTH_DOMAIN;

  const keypair = Keypair.fromSecret(secretKeyEnv());
  const publicKey = keypair.publicKey();
  const tag = `[reexecutor ${publicKey.slice(0, 8)}]`;

  const client = new EscrowGateClient({
    contractId,
    networkPassphrase,
    rpcUrl,
    publicKey,
    ...basicNodeSigner(keypair, networkPassphrase),
  });

  let token: string | null = null;

  /** The server key and domains a challenge must match, discovered once from
   * the backend's stellar.toml unless pinned in the environment. Resolved at
   * startup (below) so a misconfigured worker fails before it signs
   * anything; login reuses the same resolution. */
  let sep10ConfigPromise: Promise<Sep10ServerConfig> | null = null;
  function sep10Config(): Promise<Sep10ServerConfig> {
    sep10ConfigPromise ??= resolveSep10ServerConfig({
      backendUrl,
      serverKey: sep10ServerKey,
      homeDomain: sep10HomeDomain,
      webAuthDomain: sep10WebAuthDomain,
    });
    return sep10ConfigPromise;
  }

  async function login(): Promise<string> {
    const challengeRes = await fetch(`${backendUrl}/auth?account=${publicKey}`);
    if (!challengeRes.ok) throw new Error(`SEP-10 challenge request failed: HTTP ${challengeRes.status}`);
    const { transaction } = (await challengeRes.json()) as { transaction: string };
    // The challenge is only signed once it proves it came from the expected
    // server, for the expected domains, inside its time bounds — a challenge
    // from any other server is refused here, before the signature exists.
    const tx = verifySep10Challenge(transaction, await sep10Config(), networkPassphrase, publicKey);
    tx.sign(keypair);
    const verifyRes = await fetch(`${backendUrl}/auth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: tx.toXDR() }),
    });
    const body = (await verifyRes.json()) as { token?: string; error?: string };
    if (!body.token) throw new Error(`SEP-10 login failed: ${body.error ?? verifyRes.status}`);
    return body.token;
  }

  /** The backend's JWT lives for an hour and this process lives for weeks, so
   * every call transparently re-authenticates once on a 401. */
  async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      token ??= await login();
      const res = await fetch(`${backendUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        token = null;
        continue;
      }
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok) {
        throw new ApiError(res.status, `${init.method ?? "GET"} ${path} -> ${res.status}: ${data.error ?? "request failed"}`);
      }
      return data;
    }
  }

  const worker = createWorker({
    api,
    client,
    publicKey,
    heartbeatIntervalMs: heartbeatMs,
    retrievalRetryBudgetS,
    connectivityCheckUrl,
    internetCheckUrl,
  });

  console.log(`[reexecutor-agent] starting as ${publicKey}`);
  console.log(`[reexecutor-agent] replay engine: ${REPLAY_ENGINE}`);
  await warnIfProbePrivateAndNoInternet(connectivityCheckUrl, internetCheckUrl);
  if (isInsecureBackendUrl(backendUrl)) {
    console.warn(
      `[reexecutor-agent] BACKEND_URL is plain http to a public host (${backendUrl}) — a challenge fetched over it can be swapped on the path. Prefer https.`
    );
  }
  // Fail fast on a server we cannot trust, before the first login signs anything.
  const sep10 = await sep10Config();
  console.log(
    `[reexecutor-agent] SEP-10 server key ${sep10.serverKey.slice(0, 8)}… home domain ${sep10.homeDomain} web-auth domain ${sep10.webAuthDomain}`
  );
  await verifyBackendConfig(backendUrl, contractId, networkPassphrase);
  // Mirrors this account's real on-chain stake into the backend, so an
  // account staked by script (or long ago) is assignable without re-staking.
  const reexecutor = await worker.sync();
  console.log(
    `[reexecutor-agent] reexecutor_id=${reexecutor.id} stake=${reexecutor.stake_amount} stroops active=${reexecutor.active} approved=${reexecutor.approved}`
  );
  if (!reexecutor.active) {
    console.warn("[reexecutor-agent] stake is below the on-chain floor — no work will be assigned until it is topped up");
  }
  if (!reexecutor.approved) {
    console.warn("[reexecutor-agent] not approved as a voter — on a deployment with the allow-list on, no work is assigned until the admin approves this account");
  }

  if (once) {
    await worker.pollOnce();
    return;
  }
  // A replay can run for minutes; the assignment poll cannot, so liveness
  // is reported on its own timer. A backend that predates the endpoint
  // answers 404 and the poll keeps the worker online as before.
  worker.startHeartbeat();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await worker.pollOnce();
    } catch (err) {
      console.error(`${tag} poll failed, will retry:`, (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
