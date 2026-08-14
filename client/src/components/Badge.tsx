import type { CapabilitySource, RiskTier, UsageOutcome } from "../api/types";

const RISK_LABEL: Record<RiskTier, string> = {
  read_only: "Read-only",
  mutating: "Mutating",
  destructive: "Destructive",
};

export function RiskBadge({ tier }: { tier: RiskTier }) {
  return <span className={`badge badge-${tier}`}>{RISK_LABEL[tier]}</span>;
}

const OUTCOME_LABEL: Record<UsageOutcome, string> = {
  ok: "Allowed",
  denied: "Denied",
  error: "Error",
};

export function OutcomeBadge({ outcome }: { outcome: UsageOutcome }) {
  return <span className={`badge badge-${outcome}`}>{OUTCOME_LABEL[outcome]}</span>;
}

export function KindPill({ kind }: { kind: string }) {
  return <span className="kind-pill">{kind === "mcp_tool" ? "MCP tool" : kind}</span>;
}

const SOURCE_LABEL: Record<CapabilitySource, string> = {
  filesystem: "On disk",
  "usage-history-only": "Usage history",
  "mcp-manifest": "MCP manifest",
  manual: "Manual",
};

/** Where a capability's existence was confirmed from — same pill shape as KindPill, own tone
 * per source so "how do we know this is real" reads at a glance. */
export function SourceTag({ source }: { source?: CapabilitySource }) {
  if (!source) return null;
  return <span className={`kind-pill source-tag source-${source}`}>{SOURCE_LABEL[source]}</span>;
}
