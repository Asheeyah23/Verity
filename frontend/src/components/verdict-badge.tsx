import { Badge } from "./ui/badge";
import type { SubmissionStatus, SubmissionResolutionMethod } from "../lib/types";
import { describeVerdict } from "../lib/verdict";

export { describeVerdict };
export type { VerdictTone } from "../lib/verdict";

/** `compact` is for rows in a list: the same verdict and the same method,
 * in a few words. The full sentence belongs on the submission's own page. */
export function VerdictBadge({
  status,
  resolutionMethod,
  hasChallenge = false,
  compact = false,
  align = "start",
}: {
  status: SubmissionStatus;
  resolutionMethod?: SubmissionResolutionMethod | null;
  hasChallenge?: boolean;
  compact?: boolean;
  align?: "start" | "end";
}) {
  const { label, tone, mechanism, short } = describeVerdict(status, resolutionMethod, hasChallenge);
  return (
    <div className={`inline-flex flex-col gap-1 ${align === "end" ? "items-end text-right" : "items-start"}`}>
      <Badge tone={tone}>{label}</Badge>
      <span className={`text-xs text-text-tertiary ${compact ? "whitespace-nowrap" : "max-w-xs"}`}>
        {compact ? short : mechanism}
      </span>
    </div>
  );
}
