import { Badge } from "./ui/badge";
import type { Reexecutor } from "../lib/types";
import { reexecutorStanding } from "../lib/reexecutor-standing";

export { reexecutorStanding };
export type { ReexecutorStanding } from "../lib/reexecutor-standing";

export function ReexecutorStatus({ reexecutor, allowlist }: { reexecutor: Reexecutor; allowlist: boolean }) {
  const s = reexecutorStanding(reexecutor, allowlist);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
