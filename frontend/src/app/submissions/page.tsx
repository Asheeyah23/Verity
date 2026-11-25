import type { Metadata } from "next";
import Link from "next/link";
import { backendGet } from "../../lib/server-api";
import type { GateConfig, Submission, SubmissionStatus } from "../../lib/types";
import { Card, CardBody } from "../../components/ui/card";
import { VerdictBadge } from "../../components/verdict-badge";
import { buttonClasses } from "../../components/ui/button";
import { Pager, PAGE_SIZE, parsePage } from "../../components/pager";
import { cn } from "../../lib/utils";
import { formatRelativeTime, formatUnits, resolveBondAsset, truncateMiddle } from "../../lib/format";

export const metadata: Metadata = { title: "Submissions" };

const FILTERS: Array<{ value: SubmissionStatus | null; label: string }> = [
  { value: null, label: "All" },
  { value: "pending", label: "Pending" },
  { value: "disputed", label: "Disputed" },
  { value: "verified", label: "Verified" },
  { value: "slashed", label: "Slashed" },
  { value: "expired_unverified", label: "Expired" },
];

export default async function SubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[]; page?: string }>;
}) {
  const params = await searchParams;
  const rawStatus = Array.isArray(params.status) ? params.status[0] : params.status;
  const status = FILTERS.find((f) => f.value === rawStatus)?.value ?? null;
  const ignoredStatus =
    rawStatus && status === null && !FILTERS.some((f) => f.value === rawStatus)
      ? rawStatus
      : null;
  const page = parsePage(params.page);

  const query = new URLSearchParams({
    limit: String(PAGE_SIZE + 1),
    offset: String((page - 1) * PAGE_SIZE),
  });
  if (status) query.set("status", status);
  const [rows, config] = await Promise.all([
    backendGet<Submission[]>(`/v1/submissions?${query}`),
    backendGet<GateConfig>("/v1/config"),
  ]);
  const submissions = rows.slice(0, PAGE_SIZE);
  const asset = resolveBondAsset(config.bond_asset);

  const hrefFor = (nextStatus: SubmissionStatus | null, nextPage = 1) => {
    const q = new URLSearchParams();
    if (nextStatus) q.set("status", nextStatus);
    if (nextPage > 1) q.set("page", String(nextPage));
    const qs = q.toString();
    return qs ? `/submissions?${qs}` : "/submissions";
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Submissions</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Work that agents have bonded on EscrowGate, newest first. Each one is a real Stellar
            testnet transaction, mirrored here by the chain indexer.
          </p>
        </div>
        <Link href="/submissions/new" className={buttonClasses("primary")}>
          New submission
        </Link>
      </div>

      <nav aria-label="Filter by status" className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <Link
            key={f.label}
            href={hrefFor(f.value)}
            aria-current={f.value === status ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              f.value === status
                ? "bg-surface-hover text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            )}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {ignoredStatus && (
        <p role="status" className="text-sm text-text-secondary">
          Unknown status filter &ldquo;{truncateMiddle(ignoredStatus, 20, 20)}&rdquo; ignored. Showing all submissions.
        </p>
      )}

      {submissions.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center">
            {status || page > 1 ? (
              <>
                <p className="text-sm text-text-secondary">Nothing matches this view.</p>
                <Link href="/submissions" className="mt-2 inline-block text-sm text-accent underline-offset-2 hover:underline">
                  Show all submissions
                </Link>
              </>
            ) : (
              <>
                <p className="text-sm text-text-secondary">No work has been submitted on this deployment yet.</p>
                <p className="mx-auto mt-2 max-w-md text-sm text-text-tertiary">
                  The first submission will appear here the moment its transaction is confirmed.
                  You can make it: it takes a funded testnet wallet and about a minute.
                </p>
                <Link href="/submissions/new" className={cn(buttonClasses("secondary"), "mt-5")}>
                  New submission
                </Link>
              </>
            )}
          </CardBody>
        </Card>
      ) : (
        <ul className="space-y-3">
          {submissions.map((s) => (
            <li key={s.id}>
              <Link
                href={`/submissions/${s.id}`}
                className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <Card className="transition-colors hover:bg-surface-hover">
                  <CardBody className="flex flex-wrap items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-sm">
                        #{s.chain_submission_id}
                        <span className="ml-3 font-sans text-text-secondary">{s.escrow_ref}</span>
                      </p>
                      <p className="mt-1 text-xs text-text-tertiary">
                        {s.task_type}, agent {truncateMiddle(s.agent_id, 4, 4)}, submitted{" "}
                        {formatRelativeTime(s.submitted_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-6">
                      <p className="font-mono text-sm">
                        {formatUnits(s.bond_amount, asset.decimals, asset.symbol)} bond
                      </p>
                      <VerdictBadge status={s.status} resolutionMethod={s.resolution_method} compact align="end" />
                    </div>
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Pager page={page} hasNext={rows.length > PAGE_SIZE} hrefFor={(p) => hrefFor(status, p)} />
    </div>
  );
}
