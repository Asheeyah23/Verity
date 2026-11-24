"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "./wallet-provider";
import { Button } from "./ui/button";
import { openChallenge, relayChallenge } from "../lib/client-api";
import { assertWalletNetwork, signXdr, WalletError, wrongNetworkMessage } from "../lib/wallet";
import { TESTNET_EXPLORER_TX } from "../lib/config";
import { stroopsToXlm, xlmToStroops } from "../lib/format";

const POLL_EVERY_MS = 3000;
const GIVE_UP_AFTER_MS = 60_000;

/**
 * Opens a bonded challenge. Rendered only for a pending, on-chain submission;
 * the window itself is checked here against the clock, because it can close
 * while the page is open and the contract would then reject the transaction.
 */
export function OpenChallengeButton({
  submissionId,
  deadlineIso,
  minBondStroops,
  networkPassphrase,
}: {
  submissionId: string;
  deadlineIso: string;
  /** The contract's floor for this submission; null if not mirrored yet. */
  minBondStroops: string | null;
  networkPassphrase: string;
}) {
  const router = useRouter();
  const { account, connecting, networkOk, problem, login, reportWrongNetwork } = useWallet();
  const [bondXlm, setBondXlm] = useState(minBondStroops ? stroopsToXlm(minBondStroops) : "");
  const [busy, setBusy] = useState<null | "checking" | "building" | "signing" | "relaying">(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const [windowOpen, setWindowOpen] = useState(() => Date.now() < new Date(deadlineIso).getTime());

  const wrongNetworkNotice = !networkOk
    ? problem?.code === "wrong-network"
      ? problem.message
      : wrongNetworkMessage()
    : null;
  const displayError = wrongNetworkNotice ?? error;

  useEffect(() => {
    const id = setInterval(() => setWindowOpen(Date.now() < new Date(deadlineIso).getTime()), 1000);
    return () => clearInterval(id);
  }, [deadlineIso]);

  // The challenge row is written by the chain indexer a few seconds after
  // the transaction lands. Keep re-reading until the page shows it (at which
  // point this component is replaced by the challenge itself). Cap polling
  // to GIVE_UP_AFTER_MS so a stalled indexer does not poll forever.
  useEffect(() => {
    if (!txHash) return;
    const pollId = setInterval(() => router.refresh(), POLL_EVERY_MS);
    const timeoutId = setTimeout(() => {
      clearInterval(pollId);
      setStalled(true);
    }, GIVE_UP_AFTER_MS);

    return () => {
      clearInterval(pollId);
      clearTimeout(timeoutId);
    };
  }, [txHash, router]);

  async function handleChallenge() {
    if (!account || !networkOk) return;
    setError(null);
    const bond = xlmToStroops(bondXlm);
    if (bond === null) {
      setError("Enter the bond as a positive XLM amount, for example 5 or 5.5.");
      return;
    }
    if (minBondStroops && bond < BigInt(minBondStroops)) {
      setError(`The bond must be at least ${stroopsToXlm(minBondStroops)} XLM for this submission.`);
      return;
    }
    try {
      setBusy("checking");
      await assertWalletNetwork(networkPassphrase);
      setBusy("building");
      const { unsigned_transaction_xdr } = await openChallenge(submissionId, bond.toString());
      setBusy("signing");
      const signed = await signXdr(unsigned_transaction_xdr, {
        networkPassphrase,
        address: account,
      });
      setBusy("relaying");
      const { tx_hash } = await relayChallenge(submissionId, signed);
      setStalled(false);
      setTxHash(tx_hash);
    } catch (err) {
      if (err instanceof WalletError && err.code === "wrong-network") {
        reportWrongNetwork(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : "The challenge could not be opened.");
    } finally {
      setBusy(null);
    }
  }

  if (txHash) {
    return (
      <div className="space-y-2 text-sm" role="status">
        <p>
          {stalled
            ? "Still waiting for the indexer to record the challenge. Reload the page later, or check the transaction on stellar.expert."
            : "Challenge transaction confirmed on testnet. Waiting for the indexer to record it…"}
        </p>
        <a
          href={TESTNET_EXPLORER_TX(txHash)}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-2 hover:underline"
        >
          View transaction on stellar.expert
        </a>
      </div>
    );
  }

  if (!windowOpen) {
    return (
      <p className="text-sm text-text-tertiary">
        The challenge window has closed. This submission is waiting to be finalized and can no
        longer be challenged.
      </p>
    );
  }

  if (!account) {
    return (
      <Button variant="secondary" onClick={login} disabled={connecting}>
        {connecting ? "Connecting..." : "Connect wallet to open a challenge"}
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      <p className="max-w-prose text-sm text-text-secondary">
        A challenge puts your bond against the agent&apos;s. If re-executors find the work wrong you
        get your bond back plus a share of theirs; if they find it right, your bond goes to the
        agent.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <label htmlFor="challenge-bond" className="block text-sm text-text-secondary">
            Your bond (XLM)
          </label>
          <input
            id="challenge-bond"
            inputMode="decimal"
            value={bondXlm}
            onChange={(e) => setBondXlm(e.target.value)}
            aria-describedby="challenge-bond-help"
            className="w-36 rounded-lg border border-border-strong bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
          />
        </div>
        <Button variant="danger" onClick={handleChallenge} disabled={busy !== null || !networkOk}>
          {busy === "checking"
            ? "Checking Freighter..."
            : busy === "building"
              ? "Building transaction..."
              : busy === "signing"
                ? "Awaiting signature in Freighter..."
                : busy === "relaying"
                  ? "Submitting to testnet..."
                  : "Open challenge"}
        </Button>
      </div>
      <p id="challenge-bond-help" className="text-xs text-text-tertiary">
        {minBondStroops
          ? `Minimum ${stroopsToXlm(minBondStroops)} XLM for this submission, set by the contract.`
          : "The contract sets a minimum in proportion to the escrow value."}
      </p>
      {displayError && (
        <p role="alert" className="text-sm text-status-slashed">
          {displayError}
        </p>
      )}
    </div>
  );
}
