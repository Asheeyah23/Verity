"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "../../../components/wallet-provider";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { uploadArtifact, createSubmission, relaySubmission, ActionTimeoutError } from "../../../lib/client-api";
import { assertWalletNetwork, signXdr, WalletError, wrongNetworkMessage } from "../../../lib/wallet";
import { TESTNET_EXPLORER_TX, TESTNET_EXPLORER_ACCOUNT } from "../../../lib/config";
import { canonicalJson, parseJsonOrText } from "../../../lib/canonical";
import { EXAMPLES, EXAMPLE_LIST, generateExampleEscrowRef, type ExampleId, type SubmissionExample } from "../../../lib/examples";
import { bpsToPercent, formatDuration, formatUnits, mapTrustlineError, parseUnits, resolveBondAsset, trustlineNote } from "../../../lib/format";
import { validateRetrievalSpec } from "../../../lib/retrieval-spec";
import { cn } from "../../../lib/utils";
import type { GateConfig, TaskType } from "../../../lib/types";

function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

/** Largest artifact the dashboard will try to upload, in UTF-8 bytes. The
 * upload request carries the artifact as base64 inside JSON, and the backend
 * rejects any request over its 1 MiB body limit (`bodyLimit: 1_048_576` in
 * `backend/src/app.ts`) before Verity's own code runs. 1,048,576 base64
 * characters carry at most 786,432 raw bytes; this leaves a little room for
 * the JSON envelope. Keep it in sync with that `bodyLimit`. */
const MAX_UPLOAD_ARTIFACT_BYTES = 786_000;

/** UTF-8 size, which is what gets uploaded. `text.length` undercounts any
 * multi-byte character. */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

const formatKb = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`;

function checkArtifactSize(name: string, text: string, maxBytes: number = MAX_UPLOAD_ARTIFACT_BYTES) {
  const bytes = utf8ByteLength(text);
  if (bytes > maxBytes) {
    throw new Error(
      `The ${name} is ${formatKb(bytes)}. The largest artifact the dashboard can upload is about ${formatKb(maxBytes)}.`
    );
  }
}

type Step = "idle" | "checking" | "uploading" | "building" | "signing" | "relaying" | "done" | "error";

// The reference is free text that is hashed on-chain and shown in lists, so it is capped for sanity; keep it in line with any backend limit.
const ESCROW_REF_MAX_LENGTH = 128;

/** `config` is the contract's live rule set, so the bond floor and the
 * window shown here are the ones EscrowGate will actually apply. */
export function NewSubmissionForm({ config }: { config: GateConfig }) {
  const router = useRouter();
  const { account, connecting, networkOk, problem, login, reportWrongNetwork } = useWallet();
  const taskTypeId = useId();
  const asset = resolveBondAsset(config.bond_asset);
  // One key for this form: retrying after a declined signature reuses the
  // same draft instead of leaving a new unsigned one behind each time.
  const idempotencyKey = useRef<string | null>(null);

  const maxArtifactBytes = Math.min(
    config.artifact_max_bytes ?? MAX_UPLOAD_ARTIFACT_BYTES,
    MAX_UPLOAD_ARTIFACT_BYTES
  );

  const [escrowRef, setEscrowRef] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("deterministic");
  const [escrowValueInput, setEscrowValueInput] = useState("100");
  const [bondInput, setBondInput] = useState("5");
  const [inputContent, setInputContent] = useState("");
  const [functionContent, setFunctionContent] = useState("");
  const [outputContent, setOutputContent] = useState("");
  const [activeExample, setActiveExample] = useState<ExampleId | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);

  const filledExample = activeExample ? EXAMPLE_LIST.find((e) => e.id === activeExample) ?? null : null;

  function applyExample(example: SubmissionExample) {
    idempotencyKey.current = null;
    setError(null);
    setTaskType(example.taskType);
    setEscrowRef(generateExampleEscrowRef());
    setInputContent(example.input);
    setFunctionContent(example.functionBody);
    setOutputContent(example.output);
    setActiveExample(example.id);
  }

  const escrowRefTrimmed = escrowRef.trim();
  const escrowValue = parseUnits(escrowValueInput, asset.decimals);
  const bondValue = parseUnits(bondInput, asset.decimals);
  const minBond =
    escrowValue === null ? null : (escrowValue * BigInt(config.agent_bond_min_bps)) / BigInt(10_000);
  const windowS =
    escrowValue !== null && escrowValue >= BigInt(config.window_tier_small_ceiling)
      ? config.window_tier_large_s
      : config.window_tier_small_s;

  /** Amounts are checked here, in words, before anything is uploaded or a
   * wallet prompt appears. */
  function prepareAmounts(): { escrowValue: string; bond: string } {
    if (escrowValue === null) {
      throw new Error(`Enter the escrow value as a positive ${asset.symbol} amount, for example 100.`);
    }
    const bond = parseUnits(bondInput, asset.decimals);
    if (bond === null) {
      throw new Error(`Enter the bond as a positive ${asset.symbol} amount, for example 5.`);
    }
    if (minBond !== null && bond < minBond) {
      throw new Error(
        `The bond must be at least ${formatUnits(minBond.toString(), asset.decimals, asset.symbol)}: ${bpsToPercent(config.agent_bond_min_bps)} of the escrow value.`
      );
    }
    return { escrowValue: escrowValue.toString(), bond: bond.toString() };
  }

  /** Re-executors parse the input as JSON and hash their output in
   * canonical JSON, so both are normalised here before they are hashed —
   * otherwise a stray space or a different key order reads as a mismatch
   * and costs the agent their bond. */
  function prepareArtifacts(): { input: string; output: string } {
    let inputValue: unknown;
    try {
      inputValue = JSON.parse(inputContent);
    } catch {
      throw new Error(
        taskType === "retrieval"
          ? 'The request spec must be valid JSON, e.g. {"url": "https://...", "pointer": "/field"}.'
          : "The input must be valid JSON. It is passed to your function as `input`."
      );
    }
    if (taskType === "retrieval") {
      validateRetrievalSpec(inputValue);
    }
    if (taskType === "deterministic" && !functionContent.trim()) {
      throw new Error("A deterministic task needs the function re-executors will replay.");
    }
    const input = canonicalJson(inputValue);
    const output = canonicalJson(parseJsonOrText(outputContent));
    // Checked here, before anything is uploaded, so an oversize artifact is
    // named instead of failing the upload with a bare "Request body is too large".
    checkArtifactSize("input", input, maxArtifactBytes);
    checkArtifactSize("claimed output", output, maxArtifactBytes);
    if (taskType === "deterministic") checkArtifactSize("function", functionContent, maxArtifactBytes);
    return { input, output };
  }

  async function handleSubmit() {
    if (!account || !networkOk) return;
    setError(null);
    try {
      if (!escrowRefTrimmed) {
        throw new Error("Enter an escrow reference.");
      }
      const amounts = prepareAmounts();
      const artifacts = prepareArtifacts();
      setStep("checking");
      await assertWalletNetwork(config.network_passphrase);
      setStep("uploading");
      const input = await uploadArtifact(textToBase64(artifacts.input), "application/json");
      const output = await uploadArtifact(textToBase64(artifacts.output), "application/json");
      const fn =
        taskType === "deterministic"
          ? await uploadArtifact(textToBase64(functionContent), "text/javascript")
          : null;

      setStep("building");
      const { submission, unsigned_transaction_xdr } = await createSubmission({
        escrow_ref: escrowRefTrimmed,
        task_type: taskType,
        input_hash: input.content_hash,
        input_ref: input.storage_ref,
        claimed_output_hash: output.content_hash,
        claimed_output_ref: output.storage_ref,
        function_hash: fn?.content_hash,
        function_ref: fn?.storage_ref,
        escrow_value: amounts.escrowValue,
        bond_amount: amounts.bond,
        idempotency_key: (idempotencyKey.current ??= crypto.randomUUID()),
      });
      if (unsigned_transaction_xdr === null) {
        // This draft already reached the chain on an earlier attempt.
        router.push(`/submissions/${submission.id}`);
        return;
      }

      setStep("signing");
      const signed = await signXdr(unsigned_transaction_xdr, {
        networkPassphrase: config.network_passphrase,
        address: account,
      });

      setStep("relaying");
      await relaySubmission(submission.id, signed);
      setStep("done");
      router.push(`/submissions/${submission.id}`);
    } catch (err) {
      if (err instanceof WalletError && err.code === "wrong-network") {
        reportWrongNetwork(err.message);
        setStep("idle");
        return;
      }
      if (err instanceof ActionTimeoutError) {
        setOutcomeUnknown(true);
      } else {
        setOutcomeUnknown(false);
      }
      setError(err instanceof Error ? mapTrustlineError(err, asset.symbol) : "Submission failed.");
      setStep("error");
    }
  }

  const busy = step !== "idle" && step !== "error";
  const wrongNetworkNotice = !networkOk
    ? problem?.code === "wrong-network"
      ? problem.message
      : wrongNetworkMessage()
    : null;
  const displayError = wrongNetworkNotice ?? error;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New submission</h1>
        <p className="mt-1 max-w-prose text-sm text-text-secondary">
          Submits a real, signed transaction to EscrowGate on Stellar testnet and locks your bond
          there. A deterministic task is replayed by a quorum of re-executors; a retrieval task is
          spot-checked by one, and escalated to a quorum if that check fails.
        </p>
      </div>

      <Card>
        <CardHeader>
          <span className="font-medium">Task details</span>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field
            label="Escrow reference"
            helper="Up to 128 characters. Surrounding spaces are removed."
          >
            {(control) => (
              <input
                {...control}
                value={escrowRef}
                onChange={(e) => setEscrowRef(e.target.value)}
                maxLength={ESCROW_REF_MAX_LENGTH}
                aria-invalid={escrowRef !== "" && escrowRefTrimmed === "" ? true : undefined}
                placeholder="bounty-platform-order-id"
                className={inputClass}
              />
            )}
          </Field>

          <div className="space-y-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <label htmlFor={taskTypeId} className="block text-sm text-text-secondary">
                Task type
              </label>
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label="Fill in an example"
              >
                <span className="text-xs text-text-tertiary">Fill in an example:</span>
                {EXAMPLE_LIST.map((example) => {
                  const selected = activeExample === example.id;
                  const isWrong = example.expectedOutcome === "slashed";
                  return (
                    <Button
                      key={example.id}
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      aria-pressed={selected}
                      onClick={() => applyExample(example)}
                      className={cn(
                        "px-2.5 py-1 text-xs",
                        isWrong && "border-status-slashed/40 text-status-slashed hover:bg-status-slashed/10",
                        selected && !isWrong && "border-accent text-accent",
                        selected && isWrong && "border-status-slashed bg-status-slashed/10"
                      )}
                    >
                      {example.label}
                    </Button>
                  );
                })}
              </div>
            </div>
            <select
              id={taskTypeId}
              value={taskType}
              onChange={(e) => {
                setTaskType(e.target.value as TaskType);
                setActiveExample(null);
              }}
              className={inputClass}
            >
              <option value="deterministic">Deterministic (replay-verified)</option>
              <option value="retrieval">Retrieval (spot-checked)</option>
            </select>
            {filledExample && (
              <p
                role="status"
                className={cn(
                  "rounded-lg border px-3 py-2 text-xs",
                  filledExample.expectedOutcome === "slashed"
                    ? "border-status-slashed/40 bg-status-slashed/10 text-status-slashed"
                    : "border-border-subtle bg-surface text-text-secondary"
                )}
              >
                {filledExample.note}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label={`Escrow value (${asset.symbol})`}
              helper={`What the work is worth to the marketplace. Sets the bond floor and the challenge window: ${formatDuration(windowS)} at this value.`}
            >
              {(control) => (
                <input
                  {...control}
                  inputMode="decimal"
                  value={escrowValueInput}
                  onChange={(e) => setEscrowValueInput(e.target.value)}
                  aria-invalid={escrowValueInput !== "" && escrowValue === null}
                  className={`${inputClass} font-mono`}
                />
              )}
            </Field>
            <Field
              label={`Agent bond (${asset.symbol})`}
              helper={
                minBond === null
                  ? `At least ${bpsToPercent(config.agent_bond_min_bps)} of the escrow value. Forfeited if the work is found wrong.`
                  : `At least ${formatUnits(minBond.toString(), asset.decimals, asset.symbol)} (${bpsToPercent(config.agent_bond_min_bps)} of the escrow value). Returned if verified, forfeited if the work is found wrong.`
              }
            >
              {(control) => (
                <input
                  {...control}
                  inputMode="decimal"
                  value={bondInput}
                  onChange={(e) => setBondInput(e.target.value)}
                  aria-invalid={bondInput !== "" && bondValue === null}
                  className={`${inputClass} font-mono`}
                />
              )}
            </Field>
          </div>
          {asset.symbol !== "XLM" && (
            <p className="text-xs text-text-tertiary">{trustlineNote(asset.symbol)}</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <span className="font-medium">Content-addressed artifacts</span>
        </CardHeader>
        <CardBody className="space-y-4">
          <Field
            label={taskType === "retrieval" ? "Request spec (JSON)" : "Input (JSON)"}
            helper={
              taskType === "retrieval"
                ? `The public URL you fetched, plus an optional JSON pointer to the value you extracted (up to ${formatKb(maxArtifactBytes)}). A sampled re-executor re-fetches it.`
                : `Passed to your function as \`input\` (up to ${formatKb(maxArtifactBytes)}).`
            }
          >
            {(control) => (
              <textarea
                {...control}
                value={inputContent}
                onChange={(e) => {
                  setInputContent(e.target.value);
                  setActiveExample(null);
                }}
                rows={3}
                spellCheck={false}
                placeholder={
                  taskType === "retrieval"
                    ? EXAMPLES.retrievalCorrect.input
                    : EXAMPLES.deterministicCorrect.input
                }
                className={cnMono}
              />
            )}
          </Field>
          {taskType === "deterministic" && (
            <Field
              label="Function body (JavaScript)"
              helper={`The body of a pure function of \`input\` that returns the result (up to ${formatKb(maxArtifactBytes)}). Re-executors run this exact artifact in a WebAssembly sandbox with no network, files or clock: \`Date\` and \`Math.random\` do not exist there, and compute and memory are capped. A function that throws or exceeds the limits counts as a mismatch.`}
            >
              {(control) => (
                <textarea
                  {...control}
                  value={functionContent}
                  onChange={(e) => {
                    setFunctionContent(e.target.value);
                    setActiveExample(null);
                  }}
                  rows={4}
                  spellCheck={false}
                  placeholder={EXAMPLES.deterministicCorrect.functionBody}
                  className={cnMono}
                />
              )}
            </Field>
          )}
          <Field
            label="Claimed output"
            helper={`JSON or plain text (up to ${formatKb(maxArtifactBytes)}). Normalised to canonical JSON before hashing, so key order and whitespace do not matter.`}
          >
            {(control) => (
              <textarea
                {...control}
                value={outputContent}
                onChange={(e) => {
                  setOutputContent(e.target.value);
                  setActiveExample(null);
                }}
                rows={3}
                spellCheck={false}
                placeholder={
                  taskType === "retrieval"
                    ? EXAMPLES.retrievalCorrect.output
                    : EXAMPLES.deterministicCorrect.output
                }
                className={cnMono}
              />
            )}
          </Field>
        </CardBody>
      </Card>

      {displayError && (
        <div role="alert" className="text-sm text-status-slashed space-y-2">
          <p>{displayError}</p>
          {outcomeUnknown && account && (
            <p className="text-xs">
              The transaction may still be on-chain. Check your account on stellar.expert:{" "}
              <a
                href={TESTNET_EXPLORER_ACCOUNT(account)}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline-offset-2 hover:underline"
              >
                {account.slice(0, 6)}…{account.slice(-4)}
              </a>
            </p>
          )}
        </div>
      )}

      {account ? (
        <Button onClick={handleSubmit} disabled={busy || !networkOk || !escrowRefTrimmed || !inputContent || !outputContent}>
          {step === "checking"
            ? "Checking Freighter..."
            : step === "uploading"
              ? "Uploading artifacts..."
              : step === "building"
                ? "Building transaction..."
                : step === "signing"
                  ? "Awaiting signature in Freighter..."
                  : step === "relaying"
                    ? "Submitting to testnet..."
                    : step === "done"
                      ? "Confirmed. Opening the submission..."
                      : "Submit for verification"}
        </Button>
      ) : (
        <Button onClick={login} disabled={connecting}>
          {connecting ? "Connecting..." : "Connect wallet to continue"}
        </Button>
      )}
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm outline-none focus:border-accent";
const cnMono = `${inputClass} font-mono text-xs`;

interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
}

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: (control: FieldControlProps) => React.ReactNode;
}) {
  const controlId = useId();
  const helperId = useId();
  return (
    <div className="block space-y-2">
      <label htmlFor={controlId} className="block text-sm text-text-secondary">
        {label}
      </label>
      {children({
        id: controlId,
        "aria-describedby": helper ? helperId : undefined,
      })}
      {helper && (
        <span id={helperId} className="block max-w-[65ch] text-xs text-text-tertiary">
          {helper}
        </span>
      )}
    </div>
  );
}
