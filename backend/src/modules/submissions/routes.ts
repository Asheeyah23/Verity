import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/plugin.js";
import { db } from "../../db.js";
import { escrowGateFor } from "../../chain/clients.js";
import { minChallengerBond, readSubmission } from "../../chain/actions.js";
import { env } from "../../config/env.js";
import { assertSimulated, buildWithAccountCheck, parseGateCall, relaySignedXdr, server } from "../../chain/rpc.js";
import { bufFromHex, sha256Bytes, toChainTaskType } from "../../chain/mappers.js";
import { canonicalJson } from "../../chain/canonical.js";
import { HttpError } from "../../http-error.js";
import { findOrCreateMarketplaceForAccount } from "../marketplaces/routes.js";
import { artifactExists } from "../artifacts/storage.js";
import { submitBody } from "./schema.js";
import { decideSupersede, type ChainTxStatus } from "./supersede.js";

/** Decides whether a retry may replace an unconfirmed draft's transaction.
 * Returns the response to send when it may not (the earlier transaction is
 * already on-chain), throws 409 while it may still land, and returns null
 * when the draft is free to be rebuilt. */
async function holdBackUnconfirmedDraft(draft: { relay_started_at: Date | null; chain_tx_hash: string | null }) {
  if (!draft.relay_started_at || !draft.chain_tx_hash) return null;
  const { status } = await server.getTransaction(draft.chain_tx_hash);
  const decision = decideSupersede({
    relayStartedAt: draft.relay_started_at,
    chainStatus: status as ChainTxStatus,
  });
  if (decision === "rebuild") return null;
  if (decision === "landed") return "landed" as const;
  throw new HttpError(
    409,
    "An earlier attempt for this idempotency_key was already sent to the network and may still confirm. " +
      "Retry in a few minutes; it will resolve to that submission if it lands."
  );
}

/** An artifact reference is the storage_ref POST /v1/artifacts returned,
 * whose last path segment is the content hash. The artifact must really be
 * here — re-executors fetch it from this backend to replay the work, and a
 * submission pointing at nothing could never be replayed, only wait out its
 * window — and where the contract commits to a hash, it must be that hash. */
async function requireArtifact(label: string, ref: string | undefined, committedHash?: string) {
  if (!ref) return;
  const hash = ref.split(/[\\/]/).pop() ?? "";
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new HttpError(400, `${label} is not an artifact reference returned by POST /v1/artifacts`);
  }
  if (committedHash && hash !== committedHash) {
    throw new HttpError(400, `${label} holds different content than the hash being committed on-chain`);
  }
  if (!(await artifactExists(hash))) {
    throw new HttpError(400, `${label} points at an artifact that has not been uploaded`);
  }
}

export async function submissionsRoutes(app: FastifyInstance) {
  // Read-only list addition (beyond the PRD's literal §9 list, which only
  // specifies a per-id GET) — the dashboard has nothing to render a
  // submissions feed from without it, and faking one client-side would
  // violate the no-mocked-data requirement.
  app.get("/v1/submissions", async (req, reply) => {
    const query = z
      .object({
        marketplace_id: z.string().uuid().optional(),
        agent_id: z.string().optional(),
        status: z
          .enum(["pending", "verified", "disputed", "slashed", "expired_unverified"])
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        include_drafts: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    // Filters only: the page and the total are both derived from this, so the
    // total always counts exactly the rows the filters would page through.
    let filtered = db.selectFrom("submission");
    // A draft is a row whose submit() transaction was built but never signed
    // and relayed — it does not exist on-chain, so it is not listed by default.
    if (query.include_drafts !== "true") filtered = filtered.where("chain_submission_id", "is not", null);
    if (query.marketplace_id) filtered = filtered.where("marketplace_id", "=", query.marketplace_id);
    if (query.agent_id) filtered = filtered.where("agent_id", "=", query.agent_id);
    if (query.status) filtered = filtered.where("status", "=", query.status);
    const [rows, { total }] = await Promise.all([
      filtered.selectAll().orderBy("submitted_at", "desc").orderBy("id").limit(limit).offset(offset).execute(),
      filtered.select((eb) => eb.fn.countAll().as("total")).executeTakeFirstOrThrow(),
    ]);
    // Postgres returns count(*) as a bigint string. The body stays a bare
    // array so existing clients keep working; paging metadata is in headers.
    reply.header("x-total-count", String(Number(total)));
    reply.header("x-limit", String(limit));
    reply.header("x-offset", String(offset));
    return rows;
  });

  // Build-sign-relay-confirm step 1: create a pending row and hand back
  // unsigned XDR for the agent to sign with their own key. Verity never
  // holds the agent's signing key.
  app.post("/v1/submissions", { preHandler: requireAuth }, async (req, reply) => {
    const body = submitBody.parse(req.body);
    const agent = req.stellarAccount!;

    const existing = await db
      .selectFrom("submission")
      .selectAll()
      .where("idempotency_key", "=", body.idempotency_key)
      .where("agent_id", "=", agent)
      .executeTakeFirst();
    if (existing?.chain_submission_id) {
      // Already signed and on-chain: nothing left to sign.
      return { submission: existing, unsigned_transaction_xdr: null, network_passphrase: env.NETWORK_PASSPHRASE };
    }
    if (existing && (await holdBackUnconfirmedDraft(existing)) === "landed") {
      // The relayed transaction is on-chain; the indexer attaches the id.
      return { submission: existing, unsigned_transaction_xdr: null, network_passphrase: env.NETWORK_PASSPHRASE };
    }

    if (body.task_type === "deterministic" && (!body.function_ref || !body.input_ref)) {
      reply.code(400);
      return { error: "deterministic submissions need function_ref and input_ref artifacts for re-executors to replay" };
    }
    if (body.task_type === "retrieval" && !body.input_ref) {
      reply.code(400);
      return { error: "retrieval submissions need an input_ref artifact holding the request spec" };
    }
    await requireArtifact("input_ref", body.input_ref, body.input_hash);
    await requireArtifact("function_ref", body.function_ref, body.function_hash);
    await requireArtifact("claimed_output_ref", body.claimed_output_ref, body.claimed_output_hash);

    // Build and simulate: assertSimulated checks that simulation succeeded
    // so a submission the contract would reject (bond too low, etc.)
    // fails before creating a draft row.
    const client = escrowGateFor(agent);
    const assembled = await buildWithAccountCheck(() =>
      client.submit({
        agent,
        escrow_ref: sha256Bytes(body.escrow_ref),
        escrow_value: BigInt(body.escrow_value),
        task_type: toChainTaskType(body.task_type),
        input_hash: bufFromHex(body.input_hash),
        output_hash: bufFromHex(body.claimed_output_hash),
        bond: BigInt(body.bond_amount),
      })
    );
    assertSimulated(assembled);
    const unsignedXdr = assembled.toXDR();
    const values = {
      escrow_ref: body.escrow_ref,
      task_type: body.task_type,
      input_hash: body.input_hash,
      input_ref: body.input_ref ?? null,
      function_hash: body.function_hash ?? null,
      function_ref: body.function_ref ?? null,
      claimed_output_hash: body.claimed_output_hash,
      claimed_output_ref: body.claimed_output_ref ?? null,
      bond_amount: body.bond_amount,
      escrow_value: body.escrow_value,
      // A transaction's hash does not cover its signatures, so the hash of
      // what we just built is the hash it will have on-chain. The indexer
      // uses it to tie the SubmissionCreated event back to this exact row,
      // and the relay step uses it to accept only this transaction.
      chain_tx_hash: Buffer.from(assembled.built!.hash()).toString("hex"),
    };

    const updateExistingDraft = async (submissionId: string) => {
      // A retry of a draft that was never signed: the transaction built the
      // first time may have expired, so the draft is pointed at a fresh one.
      const row = await db
        .updateTable("submission")
        .set({ ...values, updated_at: new Date() })
        .where("id", "=", submissionId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { submission: row, unsigned_transaction_xdr: unsignedXdr, network_passphrase: env.NETWORK_PASSPHRASE };
    };

    if (existing) {
      return updateExistingDraft(existing.id);
    }

    const marketplace = await findOrCreateMarketplaceForAccount(agent);
    try {
      const row = await db
        .insertInto("submission")
        .values({
          ...values,
          marketplace_id: marketplace.id,
          agent_id: agent,
          bond_asset: "native",
          challenge_window_s: 0, // set by the contract at submit() time; filled in on relay confirm
          idempotency_key: body.idempotency_key,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      reply.code(201);
      return {
        submission: row,
        unsigned_transaction_xdr: unsignedXdr,
        network_passphrase: env.NETWORK_PASSPHRASE,
      };
    } catch (err: unknown) {
      const isUniqueViolation = typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
      if (!isUniqueViolation) {
        throw err;
      }

      const raced = await db
        .selectFrom("submission")
        .selectAll()
        .where("idempotency_key", "=", body.idempotency_key)
        .where("agent_id", "=", agent)
        .executeTakeFirst();

      if (!raced) {
        throw new HttpError(409, "idempotency_key is already in use");
      }

      if (raced.chain_submission_id || (await holdBackUnconfirmedDraft(raced)) === "landed") {
        return { submission: raced, unsigned_transaction_xdr: null, network_passphrase: env.NETWORK_PASSPHRASE };
      }

      return updateExistingDraft(raced.id);
    }
  });

  // Build-sign-relay-confirm step 2: relay the agent-signed XDR to real
  // testnet and reconcile the row with the real on-chain result. The chain
  // indexer independently reconciles the same event, so this is an
  // optimistic fast-path for the caller's own response, not the sole writer.
  app.post("/v1/submissions/:id/relay", { preHandler: requireAuth }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ signed_transaction_xdr: z.string().min(1) }).parse(req.body);
    const draft = await db.selectFrom("submission").selectAll().where("id", "=", params.id).executeTakeFirst();
    if (!draft) {
      reply.code(404);
      return { error: "not found" };
    }
    if (draft.agent_id !== req.stellarAccount) {
      reply.code(403);
      return { error: "only the submitting agent can relay this submission" };
    }
    if (draft.chain_submission_id) return { submission: draft, tx_hash: draft.chain_tx_hash };

    // Checked before anything is broadcast: only the exact transaction built
    // for this draft is relayed, never whatever the caller happened to sign.
    if (parseGateCall(body.signed_transaction_xdr).hash !== draft.chain_tx_hash) {
      reply.code(400);
      return { error: "signed transaction is not the one built for this submission" };
    }
    await db.updateTable("submission").set({ relay_started_at: new Date() }).where("id", "=", draft.id).execute();
    let relayed: Awaited<ReturnType<typeof relaySignedXdr>>;
    try {
      relayed = await relaySignedXdr(body.signed_transaction_xdr);
    } catch (err) {
      // 422 (rejected or failed on-chain) and 503 (not accepted) mean this
      // transaction cannot land, so the draft may be rebuilt at once. A 504
      // timeout leaves it marked: the transaction may still confirm.
      if (err instanceof HttpError && (err.statusCode === 422 || err.statusCode === 503)) {
        await db.updateTable("submission").set({ relay_started_at: null }).where("id", "=", draft.id).execute();
      }
      throw err;
    }
    const { hash, returnValue } = relayed;
    // From here on the transaction is on-chain. Without a u64 id the row is
    // left for the indexer, which matches the draft by its tx hash, and the
    // caller is told not to resend.
    if (typeof returnValue !== "bigint") {
      throw new HttpError(
        502,
        `Transaction ${hash} was confirmed but the network returned no submission id. ` +
          "Do not resend it; the submission will appear once the indexer has processed it."
      );
    }
    const chainSubmissionId = returnValue.toString();
    // The read-back only fills in fields the indexer also sets, so a failure
    // here is not worth failing a landed transaction over.
    let onChain: Awaited<ReturnType<typeof readSubmission>>;
    try {
      onChain = await readSubmission(chainSubmissionId);
    } catch (err) {
      console.warn(`[relay] could not read submission ${chainSubmissionId} back after relay; the indexer will fill it in`, err);
      onChain = null;
    }

    const row = await db
      .updateTable("submission")
      .set({
        chain_submission_id: chainSubmissionId,
        chain_tx_hash: hash,
        challenge_window_s: onChain ? Number(onChain.challenge_window_s) : 0,
        min_challenger_bond: onChain ? minChallengerBond(onChain).toString() : null,
        submitted_at: onChain ? new Date(Number(onChain.submitted_at) * 1000) : undefined,
        updated_at: new Date(),
      })
      .where("id", "=", params.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return { submission: row, tx_hash: hash };
  });

  app.get("/v1/submissions/:id", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const submission = await db
      .selectFrom("submission")
      .selectAll()
      .where("id", "=", params.id)
      .executeTakeFirst();
    if (!submission) {
      reply.code(404);
      return { error: "not found" };
    }
    const replays = await db
      .selectFrom("replay")
      .innerJoin("reexecutor", "reexecutor.id", "replay.reexecutor_id")
      .selectAll("replay")
      .select("reexecutor.stellar_account as reexecutor_account")
      .where("replay.submission_id", "=", params.id)
      .orderBy("replay.assigned_at")
      .execute();
    const spotChecks = await db
      .selectFrom("spot_check")
      .innerJoin("reexecutor", "reexecutor.id", "spot_check.reexecutor_id")
      .selectAll("spot_check")
      .select("reexecutor.stellar_account as reexecutor_account")
      .where("spot_check.submission_id", "=", params.id)
      .orderBy("spot_check.sampled_at")
      .execute();
    const challenge = await db
      .selectFrom("challenge")
      .selectAll()
      .where("submission_id", "=", params.id)
      .executeTakeFirst();
    const attestation = await db
      .selectFrom("attestation_export")
      .select("id")
      .where("submission_id", "=", params.id)
      .executeTakeFirst();
    return {
      submission,
      replays,
      spot_checks: spotChecks,
      challenge: challenge ?? null,
      has_attestation: Boolean(attestation),
    };
  });

  app.get("/v1/submissions/:id/proof", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const submission = await db
      .selectFrom("submission")
      .select("id")
      .where("id", "=", params.id)
      .executeTakeFirst();
    if (!submission) {
      reply.code(404);
      return { error: "not found" };
    }
    const proof = await db
      .selectFrom("zk_proof")
      .selectAll()
      .where("submission_id", "=", params.id)
      .executeTakeFirst();
    if (proof) return proof;
    // Honest by construction: nothing in Phase 1 produces or checks a proof —
    // EscrowGate rejects the ZK resolution method outright — so there is
    // never a fabricated proof here.
    return {
      available: false,
      phase: 1,
      reason:
        "ZK proving is not active in Phase 1: EscrowGate accepts no proofs and the ZKVerifierRegistry has no verifiers. Any verdict on this submission comes from bonded re-execution, not a cryptographic proof.",
    };
  });

  // The signed record of a terminal verdict. `canonical` is the exact string
  // the signature covers, so it can be verified against `signer` directly.
  app.get("/v1/submissions/:id/attestation", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await db
      .selectFrom("attestation_export")
      .selectAll()
      .where("submission_id", "=", params.id)
      .executeTakeFirst();
    if (!row) {
      reply.code(404);
      return { error: "no attestation for this submission (it is issued once a terminal verdict has settled)" };
    }
    const payload = row.payload as { attestor?: { stellar_account?: string } };
    return {
      payload,
      canonical: canonicalJson(payload),
      signature: row.signature,
      signature_algorithm: "ed25519",
      signer: payload.attestor?.stellar_account ?? null,
      // Signed and served here; not pushed to any external registry.
      delivered_to: row.target_registry === "none" ? null : row.target_registry,
      issued_at: row.exported_at,
    };
  });
}
