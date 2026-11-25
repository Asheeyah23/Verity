import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { backendGet } from "../lib/server-api";
import type { GateConfig, Reexecutor, Submission, VerificationRatesReport } from "../lib/types";
import { buttonClasses } from "../components/ui/button";
import { VerdictBadge } from "../components/verdict-badge";
import { FundAccountButton } from "../components/fund-account-button";
import { FREIGHTER_INSTALL_URL, TESTNET_EXPLORER_CONTRACT } from "../lib/config";
import {
  bpsToPercent,
  formatDuration,
  formatRelativeTime,
  formatUnits,
  resolveBondAsset,
  truncateMiddle,
} from "../lib/format";

const linkClass = "text-accent underline-offset-2 hover:underline";

type Settled<T> = { ok: true; value: T } | { ok: false };

/** Lets a decorative panel fail on its own instead of taking the page down.
 * Framework signals must pass through: `backendGet` reaches `headers()`, and
 * Next marks a route dynamic by throwing from it, so swallowing that signal
 * here would break the build and dynamic rendering. */
async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    unstable_rethrow(err);
    console.error("home page panel read failed:", err);
    return { ok: false };
  }
}

/**
 * The front door. Everything a first-time visitor is shown here is read live:
 * the latest submissions, the counts, and the rules (quorum, window, bond and
 * slash rates) straight from the contract. There is no illustrative data —
 * so a panel whose read failed says so, instead of showing a number that
 * looks real. Only the contract rules (`config`) are required: most of the
 * page's prose is derived from them, and without them there is nothing
 * truthful to render, so that failure still reaches the error screen.
 */
export default async function HomePage() {
  const [latest, report, reexecutors, config] = await Promise.all([
    settle(backendGet<Submission[]>("/v1/submissions?limit=4")),
    settle(backendGet<VerificationRatesReport>("/v1/reports/verification-rates")),
    settle(backendGet<Reexecutor[]>("/v1/reexecutors")),
    backendGet<GateConfig>("/v1/config"),
  ]);
  const totalSubmissions = report.ok
    ? report.value.by_marketplace_task_status.reduce((sum, row) => sum + Number(row.count), 0)
    : null;
  const online = reexecutors.ok
    ? reexecutors.value.filter((r) => r.online && r.can_vote).length
    : null;
  const asset = resolveBondAsset(config.bond_asset);

  return (
    <div className="space-y-20">
      <section className="grid grid-cols-1 items-start gap-10 pt-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)] lg:gap-16 lg:pt-10">
        <div>
          <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight text-balance md:text-[2.75rem]">
            Verdicts an escrow can check before it pays an agent.
          </h1>
          <p className="mt-5 max-w-[52ch] text-base leading-relaxed text-text-secondary">
            Agents bond their work on Stellar testnet. Staked re-executors replay it and vote.
            Anyone can challenge. The verdict is on-chain.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/submissions/new" className={buttonClasses("primary")}>
              Submit work
            </Link>
            <Link href="/submissions" className={buttonClasses("secondary")}>
              Browse submissions
            </Link>
          </div>
        </div>

        <div className="rounded-lg border border-border-subtle bg-surface-raised">
          <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle px-5 py-4">
            <h2 className="text-sm font-medium">Latest on-chain</h2>
            <span className="font-mono text-xs text-text-tertiary">live from the indexer</span>
          </div>
          {!latest.ok ? (
            <div className="px-5 py-10">
              <p className="text-sm text-text-secondary">
                The latest submissions could not be loaded. Reload to try again.
              </p>
            </div>
          ) : latest.value.length === 0 ? (
            <div className="px-5 py-10">
              <p className="text-sm text-text-secondary">Nothing has been submitted on this deployment yet.</p>
              <p className="mt-2 max-w-[44ch] text-sm text-text-tertiary">
                The first submission appears here as soon as its transaction confirms. Nothing on
                this page is sample data.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {latest.value.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/submissions/${s.id}`}
                    className="flex items-center justify-between gap-4 px-5 py-3.5 transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-sm">#{s.chain_submission_id}</p>
                      <p className="mt-0.5 truncate text-xs text-text-tertiary">
                        {s.task_type}, {formatRelativeTime(s.submitted_at)}, agent {truncateMiddle(s.agent_id, 4, 4)}
                      </p>
                    </div>
                    <VerdictBadge status={s.status} resolutionMethod={s.resolution_method} compact align="end" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-label="This deployment right now">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-8 border-y border-border-subtle py-8 lg:grid-cols-4">
          <Figure
            label="Submissions on-chain"
            value={totalSubmissions === null ? "Unavailable" : String(totalSubmissions)}
            note={totalSubmissions === null ? "this figure could not be read" : undefined}
          />
          <Figure
            label="Re-executors online"
            value={online === null ? "Unavailable" : String(online)}
            note={
              reexecutors.ok
                ? `${reexecutors.value.length} staked, quorum is ${config.quorum_min_reexecutors}`
                : "this figure could not be read"
            }
          />
          <Figure
            label="Re-executor slashes"
            value={report.ok ? String(report.value.slashing_events_total) : "Unavailable"}
            note={report.ok ? undefined : "this figure could not be read"}
          />
          <Figure
            label="Challenge window"
            value={formatDuration(config.window_tier_small_s)}
            note={
              config.window_tier_large_s === config.window_tier_small_s
                ? "for every submission"
                : `${formatDuration(config.window_tier_large_s)} from ${formatUnits(config.window_tier_small_ceiling, asset.decimals, asset.symbol)} of escrow value`
            }
          />
        </dl>
      </section>

      <section className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-16">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">How a submission gets its verdict</h2>
          <dl className="mt-8 space-y-7">
            <Move term="The agent submits and bonds">
              The input, the function and the claimed output are stored by hash, and at least{" "}
              {bpsToPercent(config.agent_bond_min_bps)} of the declared escrow value is locked in
              the contract.
            </Move>
            <Move term="Re-executors replay it">
              Online re-executors are picked by a deterministic hash. Each runs the function in the
              same WebAssembly sandbox, or re-fetches the declared URL, and votes match or mismatch
              on-chain with its stake behind the vote.
            </Move>
            <Move term="Anyone can challenge">
              While the window is open, a challenger can bond against the submission. A challenge is
              decided only by a quorum replaying the work, and the losing side forfeits its bond.
            </Move>
            <Move term="The contract settles">
              A {bpsToPercent(config.quorum_supermajority_bps)} bonded majority of at least{" "}
              {config.quorum_min_reexecutors} votes verifies the work or slashes the bond. A
              re-executor on the wrong side of that majority loses{" "}
              {bpsToPercent(config.reexecutor_slash_bps)} of its stake.
            </Move>
          </dl>
        </div>

        <aside className="rounded-lg border border-border-subtle bg-surface-raised p-6">
          <h2 className="text-base font-medium">What a verdict here does and does not mean</h2>
          <ul className="mt-4 space-y-3 text-sm leading-relaxed text-text-secondary">
            <li>
              It is economic, not cryptographic. A verdict says staked parties replayed the work and
              agreed. No zero-knowledge proof is produced or accepted.
            </li>
            <li>
              &ldquo;Verified by default&rdquo; means the window closed with no challenge and no
              quorum. That work was not replayed, and the page says so.
            </li>
            <li>
              It covers the artifacts the agent declared. The function is stored by hash but not
              committed on-chain.
            </li>
            {config.reexecutor_allowlist && (
              <li>
                Stake is free on testnet, so on this deployment the admin approves which staked
                accounts may vote. The admin chooses the voters, not the verdicts.
              </li>
            )}
            <li>This is Stellar testnet. The {asset.symbol} has no value and the contracts are unaudited.</li>
          </ul>
          <a
            href={TESTNET_EXPLORER_CONTRACT(config.escrow_gate_contract_id)}
            target="_blank"
            rel="noreferrer"
            className={`mt-5 inline-block font-mono text-xs ${linkClass}`}
          >
            EscrowGate {truncateMiddle(config.escrow_gate_contract_id, 6, 6)} on stellar.expert
          </a>
        </aside>
      </section>

      <section>
        <h2 className="text-2xl font-semibold tracking-tight">Try it with a testnet wallet</h2>
        <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-text-secondary">
          Every action here is a transaction you sign yourself. Verity never holds your key.
        </p>
        <ol className="mt-8 grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)]">
          <li>
            <h3 className="text-sm font-medium">Install Freighter</h3>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              The wallet extension Verity signs with. Create an account in it, or import one.
            </p>
            <a href={FREIGHTER_INSTALL_URL} target="_blank" rel="noreferrer" className={`mt-3 inline-block text-sm ${linkClass}`}>
              freighter.app
            </a>
          </li>
          <li>
            <h3 className="text-sm font-medium">Switch it to Testnet</h3>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              In Freighter, open the network menu and choose Test Net. Connecting on any other
              network is refused, so real funds are never at risk here.
            </p>
          </li>
          <li>
            <h3 className="text-sm font-medium">Connect, then get test XLM</h3>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              {asset.symbol === "XLM"
                ? "Bonds and stakes need a balance. Friendbot, the testnet faucet, sends 10,000 test XLM to a new account."
                : `Transaction fees need test XLM. Friendbot, the testnet faucet, sends 10,000 test XLM to a new account; bonds and stakes also need a ${asset.symbol} trustline and balance.`}
            </p>
            <div className="mt-4">
              <FundAccountButton bondAsset={asset} />
            </div>
          </li>
        </ol>
        <p className="mt-10 max-w-[65ch] text-sm leading-relaxed text-text-secondary">
          Then{" "}
          <Link href="/submissions/new" className={linkClass}>
            submit a piece of work
          </Link>{" "}
          and watch it get replayed, challenge someone else&apos;s from its page, or{" "}
          <Link href="/reexecutors/register" className={linkClass}>
            stake as a re-executor
          </Link>{" "}
          and run a worker of your own. The minimum stake is {formatUnits(config.min_stake_floor, asset.decimals, asset.symbol)}.
        </p>
      </section>
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-sm text-text-secondary">{label}</dt>
      <dd className="mt-2 font-mono text-3xl tracking-tight">{value}</dd>
      {note && <dd className="mt-1 text-xs text-text-tertiary">{note}</dd>}
    </div>
  );
}

function Move({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-[13rem_minmax(0,1fr)]">
      <dt className="text-sm font-medium">{term}</dt>
      <dd className="max-w-[58ch] text-sm leading-relaxed text-text-secondary">{children}</dd>
    </div>
  );
}
