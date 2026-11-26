"use client";

import { useState } from "react";
import Link from "next/link";
import { useWallet } from "../../../components/wallet-provider";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Button, buttonClasses } from "../../../components/ui/button";
import { registerReexecutor, relayReexecutorStake, ActionTimeoutError } from "../../../lib/client-api";
import { assertWalletNetwork, signXdr, WalletError, wrongNetworkMessage } from "../../../lib/wallet";
import { NETWORK_PASSPHRASE, explorerUrl } from "../../../lib/config";
import {
  formatUnits,
  mapTrustlineError,
  parseUnits,
  resolveBondAsset,
  trustlineNote,
} from "../../../lib/format";
import type { GateConfig } from "../../../lib/types";

type Status = "idle" | "checking" | "building" | "signing" | "relaying" | "done" | "error";

/** `config` is the contract's live rule set: the stake floor, the slash
 * rate, and whether voting needs the admin's approval. */
export function RegisterReexecutorForm({ config }: { config: GateConfig }) {
  const { account, connecting, networkOk, problem, login, reportWrongNetwork } = useWallet();
  const asset = resolveBondAsset(config.bond_asset);
  // Twice the floor by default: a single slash then leaves the account active.
  const [stakeInput, setStakeInput] = useState(
    formatUnits((BigInt(config.min_stake_floor) * BigInt(2)).toString(), asset.decimals)
  );
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [result, setResult] = useState<{ id: string; txHash: string; stake: bigint } | null>(null);
  const [copied, setCopied] = useState(false);

  const floor = BigInt(config.min_stake_floor);
  const floorFormatted = formatUnits(config.min_stake_floor, asset.decimals, asset.symbol);
  const stake = parseUnits(stakeInput, asset.decimals);
  const belowFloor = stake !== null && stake < floor;
  const wrongNetworkNotice = !networkOk
    ? problem?.code === "wrong-network"
      ? problem.message
      : wrongNetworkMessage()
    : null;
  const displayError = wrongNetworkNotice ?? error;

  const workerCommand = `git clone https://github.com/DevQwinB/Verity && cd Verity && pnpm install
BACKEND_URL=${config.public_api_url} \\
NETWORK_PASSPHRASE="${config.network_passphrase}" \\
ESCROW_GATE_CONTRACT_ID=${config.escrow_gate_contract_id} \\
REEXECUTOR_SECRET_KEY=<secret of the account you staked with> \\
pnpm --filter @verity/reexecutor-agent start`;

  function handleCopy() {
    navigator.clipboard.writeText(workerCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleRegister() {
    if (!account || !networkOk) return;
    setError(null);
    if (stake === null) {
      setError(`Enter the stake as a positive ${asset.symbol} amount, for example 1000.`);
      setStatus("error");
      return;
    }
    try {
      setStatus("checking");
      await assertWalletNetwork(config.network_passphrase);

      setStatus("building");
      const { reexecutor, unsigned_transaction_xdr } = await registerReexecutor(stake.toString());

      setStatus("signing");
      const signed = await signXdr(unsigned_transaction_xdr, {
        networkPassphrase: config.network_passphrase || NETWORK_PASSPHRASE,
        address: account,
      });

      setStatus("relaying");
      const { tx_hash } = await relayReexecutorStake(reexecutor.id, signed);
      setResult({ id: reexecutor.id, txHash: tx_hash, stake });
      setStatus("done");
    } catch (err) {
      if (err instanceof WalletError && err.code === "wrong-network") {
        reportWrongNetwork(err.message);
        setStatus("idle");
        return;
      }
      if (err instanceof ActionTimeoutError) {
        setOutcomeUnknown(true);
      } else {
        setOutcomeUnknown(false);
      }
      setError(err instanceof Error ? mapTrustlineError(err, asset.symbol) : "Registration failed.");
      setStatus("error");
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Link href="/reexecutors" className="text-xs text-text-tertiary hover:text-text-secondary">
          ← Re-executors
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Register as a re-executor</h1>
        <p className="mt-1 max-w-prose text-sm text-text-secondary">
          A re-executor stakes {asset.symbol} on EscrowGate, runs a worker that replays submitted work, and
          votes on-chain on whether it matches. Staking is a real, signed testnet transaction; the
          contract holds the stake.
        </p>
      </div>

      <Card>
        <CardHeader>
          <h2 className="font-medium">Before you stake</h2>
        </CardHeader>
        <CardBody>
          <ol className="max-w-prose list-decimal space-y-2 pl-5 text-sm text-text-secondary">
            <li>
              The contract&apos;s floor is <span className="font-mono text-text-primary">{floorFormatted}</span>.
              Below it an account holds stake but is assigned no work.
            </li>
            {config.reexecutor_allowlist && (
              <li>
                This deployment runs an approved voter set. After you stake, your account shows as
                pending until the deployment admin approves it; until then it cannot vote. You can
                withdraw your stake at any time while you wait.
              </li>
            )}
            <li>
              Staking alone does nothing. Work is only assigned to an account whose worker is
              running and polling. See the worker setup instructions below.
            </li>
            <li>
              A vote that a bonded consensus proves wrong costs {config.reexecutor_slash_bps / 100}% of
              your stake. The contract fixes that amount.
            </li>
          </ol>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-medium">Stake</h2>
        </CardHeader>
        <CardBody className="space-y-4">
          {status === "done" && result ? (
            <div className="space-y-3 text-sm" role="status">
              <p className="text-status-verified">
                Stake of {formatUnits(result.stake.toString(), asset.decimals, asset.symbol)} confirmed on testnet.
              </p>
              <p className="max-w-prose text-text-secondary">
                {result.stake < floor
                  ? `This is below the ${floorFormatted} floor, so the account is not yet eligible for work. Stake more to reach it.`
                  : config.reexecutor_allowlist
                    ? "Your account is now pending approval by the deployment admin. Start your worker; it will begin receiving assignments as soon as you are approved."
                    : "Your account is eligible. Start your worker and it will begin receiving assignments."}
              </p>
              <div className="flex flex-wrap items-center gap-4">
                <Link href={`/reexecutors/${result.id}`} className={buttonClasses("secondary")}>
                  View your re-executor page
                </Link>
                <a
                  href={explorerUrl("tx", result.txHash, config.network_passphrase)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline-offset-2 hover:underline"
                >
                  View transaction
                </a>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <label htmlFor="stake" className="block text-sm text-text-secondary">
                  Amount ({asset.symbol})
                </label>
                <input
                  id="stake"
                  inputMode="decimal"
                  value={stakeInput}
                  onChange={(e) => setStakeInput(e.target.value)}
                  aria-describedby="stake-help"
                  className="w-full max-w-xs rounded-lg border border-border-strong bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
                />
                <p id="stake-help" className={belowFloor ? "text-xs text-status-pending" : "text-xs text-text-tertiary"}>
                  {belowFloor
                    ? `Below the ${floorFormatted} floor: this would be staked, but the account would not be assigned work.`
                    : `At least ${floorFormatted} to be assigned work. Staking again later adds to this.`}
                </p>
                {asset.symbol !== "XLM" && (
                  <p className="text-xs text-text-tertiary">{trustlineNote(asset.symbol)}</p>
                )}
              </div>

              {displayError && (
                <div role="alert" className="text-sm text-status-slashed space-y-2">
                  <p>{displayError}</p>
                  {outcomeUnknown && account && (
                    <p className="text-xs">
                      The transaction may still be on-chain. Check your account on stellar.expert:{" "}
                      <a
                        href={explorerUrl("account", account, config.network_passphrase)}
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
                <Button onClick={handleRegister} disabled={(status !== "idle" && status !== "error") || !networkOk}>
                  {status === "checking"
                    ? "Checking Freighter..."
                    : status === "building"
                      ? "Building transaction..."
                      : status === "signing"
                        ? "Awaiting signature in Freighter..."
                        : status === "relaying"
                          ? "Submitting to testnet..."
                          : "Stake and register"}
                </Button>
              ) : (
                <Button onClick={login} disabled={connecting}>
                  {connecting ? "Connecting..." : "Connect wallet to continue"}
                </Button>
              )}
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-medium">Worker setup</h2>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-sm text-text-secondary">
            Work is only assigned to accounts whose worker is actively running and polling. Start one with this deployment&apos;s settings:
          </p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg border border-border-strong bg-surface p-4 font-mono text-xs text-text-primary">
              {workerCommand}
            </pre>
            <button
              type="button"
              onClick={handleCopy}
              className="absolute right-3 top-3 rounded-md border border-border-strong bg-surface-muted px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface hover:text-text-primary"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <p className="text-xs text-status-pending">
            Warning: Never paste your secret key into this website — only provide it directly in your own shell or a .env file.
          </p>
          <p className="text-xs text-text-tertiary">
            See{" "}
            <a
              href="https://github.com/DevQwinB/Verity/blob/main/reexecutor-agent/.env.example"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline-offset-2 hover:underline"
            >
              reexecutor-agent/.env.example
            </a>{" "}
            for all configuration options, or run using Docker with{" "}
            <code className="rounded bg-surface px-1 py-0.5 font-mono text-xs text-text-primary">
              reexecutor-agent/Dockerfile
            </code>
            .
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
