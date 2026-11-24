import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { backendGetOrNull } from "../../../lib/server-api";
import type { Artifact, Attestation, SubmissionDetail, ProofStatus } from "../../../lib/types";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Badge } from "../../../components/ui/badge";
import { VerdictBadge } from "../../../components/verdict-badge";
import { AutoRefresh } from "../../../components/auto-refresh";
import { stroopsToXlm, truncateMiddle, formatDuration, formatRelativeTime, windowDeadlineIso } from "../../../lib/format";
import { TESTNET_EXPLORER_ACCOUNT, TESTNET_EXPLORER_TX } from "../../../lib/config";
import { ChallengeWindowCountdown } from "../../../components/challenge-window-countdown";
import { OpenChallengeButton } from "../../../components/open-challenge-button";

const loadSubmissionDetail = cache((id: string) =>
  backendGetOrNull<SubmissionDetail>(`/v1/submissions/${id}`)
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  try {
    const { id } = await params;
    const detail = await loadSubmissionDetail(id);
    if (!detail) return { title: "Submission" };
    const title =
      detail.submission.chain_submission_id != null
        ? `Submission #${detail.submission.chain_submission_id}`
        : "Unsigned draft";
    return { title };
  } catch (err) {
    unstable_rethrow(err);
    return { title: "Submission" };
  }
}

const linkClass = "text-accent underline-offset-2 hover:underline";

/** The stored artifact behind a storage_ref, decoded for display. Null when
 * there is none or it cannot be read. */
async function loadArtifact(ref: string | null): Promise<string | null> {
  const hash = ref?.split(/[\\/]/).pop();
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const artifact = await backendGetOrNull<Artifact>(`/v1/artifacts/${hash}`);
  return artifact ? Buffer.from(artifact.content_base64, "base64").toString("utf8") : null;
}

type Loaded<T> = { ok: true; value: T } | { ok: false };

/** Runs one optional read so its failure only blanks its own section. A 404/400 is still a
 * value (null); anything else is logged and reported as not loaded. */
async function settle<T>(what: string, work: Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await work };
  } catch (err) {
    unstable_rethrow(err);
    console.error(`submission page: could not load ${what}`, err);
    return { ok: false };
  }
}

export default async function SubmissionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await loadSubmissionDetail(id);
  if (!detail) notFound();
  const { submission, replays, spot_checks, challenge } = detail;

  const isDraft = submission.chain_submission_id === null;

  const [proof, attestation, inputText, functionText, outputText] = await Promise.all([
    settle(`/v1/submissions/${id}/proof`, backendGetOrNull<ProofStatus>(`/v1/submissions/${id}/proof`)),
    settle(
      `/v1/submissions/${id}/attestation`,
      detail.has_attestation
        ? backendGetOrNull<Attestation>(`/v1/submissions/${id}/attestation`)
        : Promise.resolve(null)
    ),
    settle(`artifact ${submission.input_ref}`, loadArtifact(submission.input_ref)),
    settle(`artifact ${submission.function_ref}`, loadArtifact(submission.function_ref)),
    settle(`artifact ${submission.claimed_output_ref}`, loadArtifact(submission.claimed_output_ref)),
  ]);

  const deadline = windowDeadlineIso(submission.submitted_at, submission.challenge_window_s);
  const open = submission.status === "pending" || submission.status === "disputed";
  // Keep reading until the verdict is in and its settlement has been recorded.
  const live = !isDraft && (open || (submission.chain_submission_id !== null && !submission.settled_at));
  const votes = replays.filter((r) => r.status === "confirmed_onchain");

  return (
    <div className="space-y-6">
      {live && <AutoRefresh />}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/submissions" className="text-xs text-text-tertiary hover:text-text-secondary">
            ← Submissions
          </Link>
          <h1 className="mt-2 font-mono text-xl">
            {submission.chain_submission_id ? `Submission #${submission.chain_submission_id}` : "Unsigned draft"}
          </h1>
          <p className="mt-1 break-words text-sm text-text-secondary">{submission.escrow_ref}</p>
        </div>
        {isDraft ? (
          <div className="flex flex-col items-end text-right gap-1">
            <Badge tone="neutral">Not submitted on-chain</Badge>
            <p className="max-w-xs text-xs text-text-tertiary">
              This draft was never signed. Reload this page if you have just signed it.
            </p>
          </div>
        ) : (
          <VerdictBadge
            status={submission.status}
            resolutionMethod={submission.resolution_method}
            hasChallenge={challenge !== null}
            align="end"
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Task type" value={submission.task_type} capitalize />
        <Stat label="Agent bond" value={`${stroopsToXlm(submission.bond_amount)} XLM`} mono />
        <Stat label={isDraft ? "Drafted" : "Submitted"} value={formatRelativeTime(submission.submitted_at)} />
        <Card>
          <CardBody>
            {isDraft ? (
              <StatBody label="Challenge window" value="Not started" />
            ) : submission.status === "pending" && !challenge ? (
              <ChallengeWindowCountdown deadlineIso={deadline} />
            ) : (
              <StatBody label="Challenge window" value={formatDuration(submission.challenge_window_s)} />
            )}
          </CardBody>
        </Card>
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Fact label="Agent">
          <a href={TESTNET_EXPLORER_ACCOUNT(submission.agent_id)} target="_blank" rel="noreferrer" className={`font-mono text-xs ${linkClass}`}>
            {truncateMiddle(submission.agent_id, 8, 8)}
          </a>
        </Fact>
        {submission.escrow_value && (
          <Fact label="Declared escrow value">
            <span className="font-mono">{stroopsToXlm(submission.escrow_value)} XLM</span>
          </Fact>
        )}
        {submission.chain_tx_hash && submission.chain_submission_id && (
          <Fact label="Submit transaction">
            <a href={TESTNET_EXPLORER_TX(submission.chain_tx_hash)} target="_blank" rel="noreferrer" className={`font-mono text-xs ${linkClass}`}>
              {truncateMiddle(submission.chain_tx_hash, 8, 8)}
            </a>
          </Fact>
        )}
        {submission.finalize_tx_hash && (
          <Fact label="Finalize transaction">
            <a href={TESTNET_EXPLORER_TX(submission.finalize_tx_hash)} target="_blank" rel="noreferrer" className={`font-mono text-xs ${linkClass}`}>
              {truncateMiddle(submission.finalize_tx_hash, 8, 8)}
            </a>
          </Fact>
        )}
      </dl>

      <Card>
        <CardHeader>
          <h2 className="font-medium">What was declared</h2>
          <p className="mt-1 max-w-prose text-xs text-text-tertiary">
            The artifacts re-executors fetch and replay. Each is stored under its own sha256 hash;
            the input and claimed-output hashes are the ones committed on-chain. The function is
            not committed on-chain, so a verdict means &ldquo;consistent with these artifacts&rdquo;.
          </p>
        </CardHeader>
        <CardBody className="space-y-5">
          <ArtifactBlock
            label={submission.task_type === "retrieval" ? "Request spec" : "Input"}
            hash={submission.input_hash}
            text={inputText.ok ? inputText.value : null}
            failed={!inputText.ok}
          />
          {submission.task_type === "deterministic" && (
            <ArtifactBlock
              label="Function body"
              hash={submission.function_hash}
              text={functionText.ok ? functionText.value : null}
              failed={!functionText.ok}
            />
          )}
          <ArtifactBlock
            label="Claimed output"
            hash={submission.claimed_output_hash}
            text={outputText.ok ? outputText.value : null}
            failed={!outputText.ok}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-medium">Replay attestations</h2>
          {replays.length > 0 && (
            <p className="mt-1 text-xs text-text-tertiary">
              {votes.length} of {replays.length} assigned re-executor{replays.length === 1 ? "" : "s"} voted on-chain.
            </p>
          )}
        </CardHeader>
        <CardBody className="p-0">
          {replays.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-text-tertiary">
              {isDraft
                ? "Not on-chain yet, so no re-executor can be assigned."
                : submission.task_type === "retrieval"
                  ? "A retrieval task is spot-checked first. It is only replayed by a full quorum if that check fails or someone challenges it."
                  : open
                    ? "No re-executor has been assigned yet. Assignment waits for one to be online."
                    : "No re-executor replayed this submission."}
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {replays.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <Link href={`/reexecutors/${r.reexecutor_id}`} className={`font-mono text-xs ${linkClass}`}>
                    {truncateMiddle(r.reexecutor_account, 6, 6)}
                  </Link>
                  <div className="flex items-center gap-4">
                    {r.status === "confirmed_onchain" && r.match !== null ? (
                      <span className={r.match ? "text-status-verified" : "text-status-slashed"}>
                        {r.match ? "Match" : "Mismatch"}
                      </span>
                    ) : (
                      <span className="text-text-tertiary">
                        {r.status === "missed" ? "Did not vote" : "Assigned, no vote yet"}
                      </span>
                    )}
                    {r.slash_tx_hash && (
                      <a href={TESTNET_EXPLORER_TX(r.slash_tx_hash)} target="_blank" rel="noreferrer" className="text-xs text-status-slashed underline-offset-2 hover:underline">
                        slashed
                      </a>
                    )}
                    {r.tx_hash && (
                      <a href={TESTNET_EXPLORER_TX(r.tx_hash)} target="_blank" rel="noreferrer" className={`text-xs ${linkClass}`}>
                        vote tx
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {submission.task_type === "retrieval" && (
        <Card>
          <CardHeader>
            <h2 className="font-medium">Spot check</h2>
          </CardHeader>
          <CardBody className="p-0">
            {spot_checks.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-text-tertiary">
                {isDraft
                  ? "Not on-chain yet, so nothing has been sampled."
                  : open
                    ? "Waiting for a re-executor to be online to sample this."
                    : "This submission was not sampled."}
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {spot_checks.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
                    <Link href={`/reexecutors/${s.reexecutor_id}`} className={`font-mono text-xs ${linkClass}`}>
                      {truncateMiddle(s.reexecutor_account, 6, 6)}
                    </Link>
                    <span
                      className={
                        s.result === "match"
                          ? "text-status-verified"
                          : s.result === "mismatch"
                            ? "text-status-slashed"
                            : "text-text-tertiary"
                      }
                    >
                      {s.result === "match"
                        ? "Match"
                        : s.result === "mismatch"
                          ? "Mismatch, escalated to a full quorum"
                          : open
                            ? "Sampled, no result yet"
                            : "No result"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h2 className="font-medium">Challenge</h2>
        </CardHeader>
        <CardBody className="space-y-3">
          {challenge ? (
            <div className="space-y-2 text-sm">
              <p>
                <a href={TESTNET_EXPLORER_ACCOUNT(challenge.challenger_account)} target="_blank" rel="noreferrer" className={`font-mono text-xs ${linkClass}`}>
                  {truncateMiddle(challenge.challenger_account, 6, 6)}
                </a>{" "}
                bonded <span className="font-mono">{stroopsToXlm(challenge.challenger_bond)} XLM</span>{" "}
                against this submission {formatRelativeTime(challenge.opened_at)}.
              </p>
              <p className="text-text-secondary">
                {challenge.resolution === "upheld"
                  ? "Upheld by bonded re-execution consensus: the work was found wrong. The challenger got their bond back plus a share of the agent's."
                  : challenge.resolution === "rejected"
                    ? "Rejected by bonded re-execution consensus: the work was found right. The challenger's bond went to the agent."
                    : challenge.resolution === "expired" || challenge.resolved_at
                      ? "Expired: re-executors did not reach a consensus within a further window. Both bonds were returned."
                      : "Open. It resolves when a quorum of re-executors reaches consensus, or expires one window after it was opened."}
              </p>
              {challenge.chain_tx_hash && (
                <a href={TESTNET_EXPLORER_TX(challenge.chain_tx_hash)} target="_blank" rel="noreferrer" className={`text-xs ${linkClass}`}>
                  View challenge transaction
                </a>
              )}
            </div>
          ) : !submission.chain_submission_id ? (
            <p className="text-sm text-text-tertiary">
              This draft was never signed, so it is not on-chain and there is nothing to challenge.
            </p>
          ) : submission.status === "pending" ? (
            <OpenChallengeButton
              submissionId={submission.id}
              deadlineIso={deadline}
              minBondStroops={submission.min_challenger_bond}
            />
          ) : (
            <p className="text-sm text-text-tertiary">
              This submission was finalized without a challenge and can no longer be challenged.
            </p>
          )}
        </CardBody>
      </Card>

      {attestation.ok && attestation.value && (
        <Card>
          <CardHeader>
            <h2 className="font-medium">Signed attestation</h2>
            <p className="mt-1 max-w-prose text-xs text-text-tertiary">
              Verity&apos;s signed record of this verdict. The signature covers the canonical JSON of the
              payload, so anyone can check it against the signer&apos;s key. It is stored and served
              here; it has not been pushed to any external registry.
            </p>
          </CardHeader>
          <CardBody className="space-y-3 text-sm">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
              {attestation.value.signer && (
                <Fact label="Signer">
                  <a href={TESTNET_EXPLORER_ACCOUNT(attestation.value.signer)} target="_blank" rel="noreferrer" className={`font-mono text-xs ${linkClass}`}>
                    {truncateMiddle(attestation.value.signer, 8, 8)}
                  </a>
                </Fact>
              )}
              <Fact label="Signature (ed25519, base64)">
                <span className="break-all font-mono text-xs text-text-secondary">{attestation.value.signature}</span>
              </Fact>
            </dl>
            <pre className="max-h-64 overflow-auto rounded-lg border border-border-subtle bg-surface p-3 font-mono text-xs leading-relaxed text-text-secondary">
              {JSON.stringify(attestation.value.payload, null, 2)}
            </pre>
          </CardBody>
        </Card>
      )}

      {detail.has_attestation && !attestation.ok && (
        <Card>
          <CardHeader>
            <h2 className="font-medium">Signed attestation</h2>
          </CardHeader>
          <CardBody>
            <p className="text-sm text-text-tertiary">
              The signed attestation could not be loaded. Reload the page to try again.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h2 className="font-medium">Proof status</h2>
        </CardHeader>
        <CardBody>
          {!proof.ok ? (
            <p className="max-w-prose text-sm text-text-tertiary">Proof status could not be loaded right now.</p>
          ) : proof.value?.available ? (
            <p className="text-sm text-status-verified">A ZK proof artifact is available.</p>
          ) : (
            <p className="max-w-prose text-sm text-text-secondary">
              {proof.value?.reason ??
                "ZK proving is not active in Phase 1. Verdicts come from bonded re-execution, not cryptographic proof."}
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function StatBody({ label, value, mono, capitalize }: { label: string; value: string; mono?: boolean; capitalize?: boolean }) {
  return (
    <>
      <p className="text-xs uppercase tracking-wide text-text-tertiary">{label}</p>
      <p className={`mt-2 text-sm ${mono ? "font-mono" : ""} ${capitalize ? "capitalize" : ""}`}>{value}</p>
    </>
  );
}

function Stat(props: { label: string; value: string; mono?: boolean; capitalize?: boolean }) {
  return (
    <Card>
      <CardBody>
        <StatBody {...props} />
      </CardBody>
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-text-tertiary">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

function ArtifactBlock({
  label,
  hash,
  text,
  failed,
}: {
  label: string;
  hash: string | null;
  text: string | null;
  failed?: boolean;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm text-text-secondary">{label}</h3>
        {hash && <span className="font-mono text-xs text-text-tertiary">sha256 {truncateMiddle(hash, 10, 10)}</span>}
      </div>
      {failed ? (
        <p className="mt-2 text-sm text-text-tertiary">Could not be loaded right now.</p>
      ) : text === null ? (
        <p className="mt-2 text-sm text-text-tertiary">Not stored on this deployment.</p>
      ) : (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-subtle bg-surface p-3 font-mono text-xs leading-relaxed">
          {text}
        </pre>
      )}
    </div>
  );
}
