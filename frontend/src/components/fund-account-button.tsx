"use client";

import { useState } from "react";
import { useWallet } from "./wallet-provider";
import { Button } from "./ui/button";
import { fundTestnetAccount } from "../lib/client-api";
import type { BondAsset } from "../lib/types";

/** Asks the testnet faucet for test XLM for the connected account. On a
 * non-native bond deployment, Friendbot only covers XLM transaction fees;
 * bonds and stakes require a trustline and balance in the bond asset. */
export function FundAccountButton({ bondAsset }: { bondAsset?: Pick<BondAsset, "symbol"> }) {
  const { account, connecting, login } = useWallet();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const symbol = bondAsset?.symbol ?? "XLM";
  const isNative = symbol === "XLM";

  async function handleFund() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await fundTestnetAccount();
      setMessage({ ok: true, text: result.message });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "The faucet request failed." });
    } finally {
      setBusy(false);
    }
  }

  if (!account) {
    return (
      <Button variant="secondary" onClick={login} disabled={connecting}>
        {connecting ? "Connecting..." : "Connect wallet"}
      </Button>
    );
  }
  return (
    <div className="space-y-2">
      <Button variant="secondary" onClick={handleFund} disabled={busy}>
        {busy
          ? "Asking Friendbot..."
          : isNative
            ? "Fund my testnet account"
            : "Fund test XLM for fees"}
      </Button>
      {!isNative && (
        <p className="text-xs text-text-tertiary">
          Friendbot only provides test XLM for transaction fees. Your account also needs a trustline
          to {symbol} and a {symbol} balance to bond or stake.
        </p>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-text-secondary" : "text-sm text-status-slashed"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
