import type { Metadata } from "next";
import Link from "next/link";
import { backendGet } from "../../lib/server-api";
import type { GateConfig, Reexecutor } from "../../lib/types";
import { Card, CardBody } from "../../components/ui/card";
import { buttonClasses } from "../../components/ui/button";
import { ReexecutorStatus } from "../../components/reexecutor-status";
import { cn } from "../../lib/utils";
import { formatRelativeTime, formatUnits, resolveBondAsset, truncateMiddle } from "../../lib/format";

export const metadata: Metadata = { title: "Re-executors" };

export default async function ReexecutorsPage() {
  const [reexecutors, config] = await Promise.all([
    backendGet<Reexecutor[]>("/v1/reexecutors"),
    backendGet<GateConfig>("/v1/config"),
  ]);
  const asset = resolveBondAsset(config.bond_asset);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Re-executor network</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Accounts with stake on EscrowGate that replay submitted work and vote on it. Each
            submission is assigned to {config.quorum_min_reexecutors} or more of those online, picked
            by a deterministic hash rather than by anyone&apos;s choice.
            {config.reexecutor_allowlist &&
              " On this deployment a staked account votes only once the admin has approved it."}
          </p>
        </div>
        <Link href="/reexecutors/register" className={buttonClasses("primary")}>
          Register as re-executor
        </Link>
      </div>

      {reexecutors.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center">
            <p className="text-sm text-text-secondary">No account has staked on this deployment yet.</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-text-tertiary">
              Until re-executors are staked and online, submissions cannot be replayed and simply
              wait out their challenge window.
            </p>
            <Link href="/reexecutors/register" className={cn(buttonClasses("secondary"), "mt-5")}>
              Stake as a re-executor
            </Link>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-text-tertiary">
                  <th scope="col" className="px-5 py-3 font-medium">Account</th>
                  <th scope="col" className="px-5 py-3 font-medium">Status</th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">Stake</th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">Votes</th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">Missed</th>
                  <th scope="col" className="px-5 py-3 text-right font-medium">Slashed</th>
                  <th scope="col" className="px-5 py-3 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {reexecutors.map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-3">
                      <Link
                        href={`/reexecutors/${r.id}`}
                        className="font-mono text-xs text-accent underline-offset-2 hover:underline"
                      >
                        {truncateMiddle(r.stellar_account, 6, 6)}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <ReexecutorStatus reexecutor={r} allowlist={config.reexecutor_allowlist} />
                    </td>
                    <td className="px-5 py-3 text-right font-mono">
                      {formatUnits(r.stake_amount, asset.decimals, asset.symbol)}
                    </td>
                    <td className="px-5 py-3 text-right font-mono">{r.stats.attested}</td>
                    <td className="px-5 py-3 text-right font-mono">{r.stats.missed}</td>
                    <td className="px-5 py-3 text-right font-mono">{r.slashed_count}</td>
                    <td className="px-5 py-3 text-text-tertiary">{formatRelativeTime(r.joined_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
