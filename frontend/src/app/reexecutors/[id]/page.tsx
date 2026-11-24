import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, unstable_rethrow } from "next/navigation";
import { backendGet, backendGetOrNull } from "../../../lib/server-api";
import type { GateConfig, Reexecutor, SlashingEvent } from "../../../lib/types";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { ReexecutorStatus, reexecutorStanding } from "../../../components/reexecutor-status";
import { WithdrawStake } from "../../../components/withdraw-stake";
import { stroopsToXlm, truncateMiddle, formatRelativeTime } from "../../../lib/format";
import { TESTNET_EXPLORER_ACCOUNT, TESTNET_EXPLORER_TX } from "../../../lib/config";

const loadReexecutorDetail = cache((id: string) =>
  backendGetOrNull<{ reexecutor: Reexecutor; slashing_events: SlashingEvent[] }>(
    `/v1/reexecutors/${id}`
  )
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  try {
    const { id } = await params;
    const data = await loadReexecutorDetail(id);
    if (!data) return { title: "Re-executor" };
    return {
      title: `Re-executor ${truncateMiddle(data.reexecutor.stellar_account, 6, 6)}`,
    };
  } catch (err) {
    unstable_rethrow(err);
    return { title: "Re-executor" };
  }
}

export default async function ReexecutorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [data, config] = await Promise.all([
    loadReexecutorDetail(id),
    backendGet<GateConfig>("/v1/config"),
  ]);
  if (!data) notFound();
  const { reexecutor, slashing_events } = data;
  const standing = reexecutorStanding(reexecutor, config.reexecutor_allowlist);
  const { stats } = reexecutor;
  const judged = stats.agreed + stats.disagreed;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/reexecutors" className="text-xs text-text-tertiary hover:text-text-secondary">
            ← Re-executors
          </Link>
          <h1 className="mt-2 font-mono text-xl">{truncateMiddle(reexecutor.stellar_account, 8, 8)}</h1>
          <a
            href={TESTNET_EXPLORER_ACCOUNT(reexecutor.stellar_account)}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-accent underline-offset-2 hover:underline"
          >
            View account on stellar.expert
          </a>
        </div>
        <div className="flex max-w-xs flex-col items-end gap-1 text-right">
          <ReexecutorStatus reexecutor={reexecutor} allowlist={config.reexecutor_allowlist} />
          <span className="text-xs text-text-tertiary">{standing.note}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Stake" value={`${stroopsToXlm(reexecutor.stake_amount)} XLM`} hint={`Floor ${stroopsToXlm(config.min_stake_floor)} XLM`} />
        <Tile
          label="Votes cast"
          value={String(stats.attested)}
          hint={stats.missed > 0 ? `${stats.missed} assignment${stats.missed === 1 ? "" : "s"} missed` : "No assignment missed"}
        />
        <Tile
          label="Agreed with consensus"
          value={judged === 0 ? "None yet" : `${stats.agreed} of ${judged}`}
          hint={judged === 0 ? "No vote has been judged by a consensus yet" : "Votes on submissions a quorum settled"}
        />
        <Tile
          label="Last seen"
          value={reexecutor.last_seen_at ? formatRelativeTime(reexecutor.last_seen_at) : "Never"}
          hint={`Joined ${formatRelativeTime(reexecutor.joined_at)}`}
        />
      </div>

      <WithdrawPanel>
        <WithdrawStake
          reexecutorId={reexecutor.id}
          account={reexecutor.stellar_account}
          stakeStroops={reexecutor.stake_amount}
          floorStroops={config.min_stake_floor}
          networkPassphrase={config.network_passphrase}
        />
      </WithdrawPanel>

      <Card>
        <CardHeader>
          <h2 className="font-medium">Slashing history</h2>
          <p className="mt-1 max-w-prose text-xs text-text-tertiary">
            A re-executor loses {config.reexecutor_slash_bps / 100}% of its stake for a vote that a bonded
            consensus proves wrong. The amount is fixed by the contract.
          </p>
        </CardHeader>
        <CardBody className="p-0">
          {slashing_events.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-text-tertiary">
              This account has never been slashed.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {slashing_events.map((event) => (
                <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <div>
                    <p>
                      {event.submission_id ? (
                        <Link href={`/submissions/${event.submission_id}`} className="text-accent underline-offset-2 hover:underline">
                          Submission #{event.chain_submission_id}
                        </Link>
                      ) : (
                        "A submission this dashboard does not track"
                      )}
                      : {event.reason}
                    </p>
                    <p className="text-xs text-text-tertiary">{formatRelativeTime(event.created_at)}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-status-slashed">−{stroopsToXlm(event.amount)} XLM</p>
                    {event.tx_hash && (
                      <a
                        href={TESTNET_EXPLORER_TX(event.tx_hash)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-accent underline-offset-2 hover:underline"
                      >
                        tx
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardBody>
        <p className="text-xs uppercase tracking-wide text-text-tertiary">{label}</p>
        <p className="mt-2 font-mono text-lg">{value}</p>
        <p className="mt-1 text-xs text-text-tertiary">{hint}</p>
      </CardBody>
    </Card>
  );
}

/** The withdraw control renders nothing unless the connected wallet owns
 * this account; `empty:hidden` keeps the card from showing as an empty box. */
function WithdrawPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-raised px-5 py-4 empty:hidden">
      {children}
    </div>
  );
}
