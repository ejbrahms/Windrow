import type { CapabilitySource, RiskTier, UsageOutcome } from "../api/types";
import { ASSURANCE_LONG, ASSURANCE_SHORT, isAssuranceLevel } from "../api/assurance";

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
  // "approved": a destructive call the harness's ask prompt approved after an initial denial
  // — see RecentCallsCard's own tab for this.
  approved: "Approved (ask)",
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

/**
 * How strongly the identity behind a row was established — 3 server-verified, 2 OS-read on the
 * calling machine, 1 a username off the environment (docs/design/global-identity-and-central-db.md
 * §1.4). Tone tracks how much the value can be trusted, not whether anything went wrong: a tier-1
 * call may have been perfectly fine, but the row's claim about *who made it* rests on something the
 * calling process could have set itself.
 *
 * Renders a plain em dash when the tier wasn't recorded (an event predating the column, or a call
 * with no hook behind it) rather than a badge — "unknown" drawn as a badge reads like a fourth tier.
 */
export function AssuranceBadge({ level }: { level: number | null | undefined }) {
  if (!isAssuranceLevel(level)) return <span className="muted">—</span>;
  return (
    <span className={`badge badge-assurance-${level}`} title={ASSURANCE_LONG[level]}>
      {ASSURANCE_SHORT[level]}
    </span>
  );
}
