import type { Metadata } from "next";
import Link from "next/link";
import { backendGet } from "../../lib/server-api";
import type { ChallengeListItem } from "../../lib/types";
import { Card, CardBody } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Pager, PAGE_SIZE, parsePage } from "../../components/pager";
import { stroopsToXlm, truncateMiddle, formatRelativeTime } from "../../lib/format";
import { TESTNET_EXPLORER_TX } from "../../lib/config";

export const metadata: Metadata = { title: "Challenges" };

/** What actually happened to a challenge, from the mirrored chain state. An
 * expired challenge is closed as `expired` — it is neither open nor decided. A
 * row closed before that outcome was stored has a closing time and no resolution. */
function outcome(c: ChallengeListItem): { label: string; tone: "pending" | "slashed" | "verified" | "expired"; note: string } {
  if (c.resolution === "upheld") {
    return { label: "Upheld", tone: "slashed", note: "Re-execution consensus found the work wrong" };
  }
  if (c.resolution === "rejected") {
    return { label: "Rejected", tone: "verified", note: "Re-execution consensus found the work right" };
  }
  if (c.resolution === "expired" || c.resolved_at) {
    return { label: "Expired", tone: "expired", note: "No consensus was reached; both bonds returned" };
  }
  return { label: "Open", tone: "pending", note: "Awaiting re-execution consensus" };
}

export default async function ChallengesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const page = parsePage((await searchParams).page);
  const rows = await backendGet<ChallengeListItem[]>(
    `/v1/challenges?limit=${PAGE_SIZE + 1}&offset=${(page - 1) * PAGE_SIZE}`
  );
  const challenges = rows.slice(0, PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Challenges</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">
          Bonded disputes against submissions, newest first. A challenge is decided only by a
          quorum of re-executors replaying the work; if none forms, it expires and both bonds go
          back.
        </p>
      </div>

      {challenges.length === 0 ? (
        <Card>
          <CardBody className="py-12 text-center">
            <p className="text-sm text-text-secondary">
              {page > 1 ? "No more challenges." : "Nobody has challenged a submission on this deployment yet."}
            </p>
            {page === 1 && (
              <p className="mx-auto mt-2 max-w-md text-sm text-text-tertiary">
                Any pending submission can be challenged from its own page while its window is open.
              </p>
            )}
          </CardBody>
        </Card>
      ) : (
        <ul className="space-y-3">
          {challenges.map((c) => {
            const o = outcome(c);
            return (
              <li key={c.id}>
                <Card>
                  <CardBody className="flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <Link
                        href={`/submissions/${c.submission_id}`}
                        className="font-mono text-sm text-accent underline-offset-2 hover:underline"
                      >
                        Submission #{c.chain_submission_id}
                      </Link>
                      <p className="mt-1 text-xs text-text-tertiary">
                        Challenger {truncateMiddle(c.challenger_account, 6, 6)}, opened{" "}
                        {formatRelativeTime(c.opened_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <p className="font-mono text-sm">{stroopsToXlm(c.challenger_bond)} XLM bond</p>
                        <p className="text-xs text-text-tertiary">{o.note}</p>
                      </div>
                      <Badge tone={o.tone}>{o.label}</Badge>
                      {c.chain_tx_hash && (
                        <a
                          href={TESTNET_EXPLORER_TX(c.chain_tx_hash)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-accent underline-offset-2 hover:underline"
                        >
                          tx
                        </a>
                      )}
                    </div>
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Pager
        page={page}
        hasNext={rows.length > PAGE_SIZE}
        hrefFor={(p) => (p > 1 ? `/challenges?page=${p}` : "/challenges")}
      />
    </div>
  );
}
