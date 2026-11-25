"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "./wallet-provider";
import { Button } from "./ui/button";
import { buildStakeWithdrawal, relayReexecutorStake } from "../lib/client-api";
import { assertWalletNetwork, signXdr, WalletError, wrongNetworkMessage } from "../lib/wallet";
import { TESTNET_EXPLORER_TX } from "../lib/config";
import { formatUnits, parseUnits, resolveBondAsset } from "../lib/format";
import type { BondAsset } from "../lib/types";

/** Lets a re-executor take stake back out. Renders nothing unless the
 * connected wallet is this re-executor's own account. */
export function WithdrawStake({
  reexecutorId,
  account,
  stakeStroops,
  floorStroops,
  networkPassphrase,
  bondAsset,
}: {
  reexecutorId: string;
  account: string;
  stakeStroops: string;
  floorStroops: string;
  networkPassphrase: string;
  bondAsset?: BondAsset | "native";
}) {
  const router = useRouter();
  const wallet = useWallet();
  const asset = resolveBondAsset(bondAsset);
  const [amountInput, setAmountInput] = useState("");
  const [busy, setBusy] = useState<null | "checking" | "building" | "signing" | "relaying">(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  if (wallet.account !== account || BigInt(stakeStroops) === BigInt(0)) return null;

  const wrongNetworkNotice = !wallet.networkOk
    ? wallet.problem?.code === "wrong-network"
      ? wallet.problem.message
      : wrongNetworkMessage()
    : null;
  const displayError = wrongNetworkNotice ?? error;

  async function handleWithdraw() {
    if (!wallet.networkOk) return;
    setError(null);
    setTxHash(null);
    const amount = parseUnits(amountInput, asset.decimals);
    if (amount === null) {
      setError(`Enter the amount as a positive ${asset.symbol} figure, for example 100.`);
      return;
    }
    if (amount > BigInt(stakeStroops)) {
      setError(`You have ${formatUnits(stakeStroops, asset.decimals, asset.symbol)} staked.`);
      return;
    }
    try {
      setBusy("checking");
      await assertWalletNetwork(networkPassphrase);
      setBusy("building");
      const { unsigned_transaction_xdr } = await buildStakeWithdrawal(reexecutorId, amount.toString());
      setBusy("signing");
      const signed = await signXdr(unsigned_transaction_xdr, { networkPassphrase, address: account });
      setBusy("relaying");
      const { tx_hash } = await relayReexecutorStake(reexecutorId, signed);
      setTxHash(tx_hash);
      setAmountInput("");
      router.refresh();
    } catch (err) {
      if (err instanceof WalletError && err.code === "wrong-network") {
        wallet.reportWrongNetwork(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : "The withdrawal could not be completed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="max-w-prose text-sm text-text-secondary">
        This is your account. Stake above the {formatUnits(floorStroops, asset.decimals, asset.symbol)} floor can leave at
        any time; going below it stops new assignments, and the contract refuses that while any of
        your votes is on a submission that has not been finalized.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <label htmlFor="withdraw-amount" className="block text-sm text-text-secondary">
            Amount ({asset.symbol})
          </label>
          <input
            id="withdraw-amount"
            inputMode="decimal"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            placeholder={formatUnits(stakeStroops, asset.decimals)}
            className="w-40 rounded-lg border border-border-strong bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
          />
        </div>
        <Button variant="secondary" onClick={handleWithdraw} disabled={busy !== null || !wallet.networkOk}>
          {busy === "checking"
            ? "Checking Freighter..."
            : busy === "building"
              ? "Building transaction..."
              : busy === "signing"
                ? "Awaiting signature in Freighter..."
                : busy === "relaying"
                  ? "Submitting to testnet..."
                  : "Withdraw stake"}
        </Button>
      </div>
      {displayError && (
        <p role="alert" className="text-sm text-status-slashed">
          {displayError}
        </p>
      )}
      {txHash && (
        <p role="status" className="text-sm">
          Withdrawal confirmed on testnet.{" "}
          <a href={TESTNET_EXPLORER_TX(txHash)} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
            View transaction
          </a>
        </p>
      )}
    </div>
  );
}
