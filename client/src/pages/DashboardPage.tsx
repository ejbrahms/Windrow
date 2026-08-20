import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useFetch } from "../api/useFetch";
import type { CapabilityKind, CapabilitySource, RiskTier, UsageGranularity } from "../api/types";
import { StatTile } from "../components/StatTile";
import { LineChart } from "../components/LineChart";
import { LatencyBreakdownChart } from "../components/LatencyBreakdownChart";
import { BarChart } from "../components/BarChart";
import { InvokePanel } from "../components/InvokePanel";
import { RecentCallsCard } from "../components/RecentCallsCard";
import { OwnerProposalsCard } from "../components/OwnerProposalsCard";
import { NativeCallsCard } from "../components/NativeCallsCard";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// null means no event in the window carries that phase (predates the breakdown, or failed open
// before reaching it) — show a dash instead of a misleading 0ms.
function ms(n: number | null): string {
  return n === null ? "—" : `${Math.round(n)}ms`;
}

// Default lookback window per granularity — mirrors the server's own defaults (server/app.js),
// so switching granularity without touching the window field lands on a sane range.
const DEFAULT_WINDOW_MINUTES: Record<UsageGranularity, number> = {
  minute: 60,
  hour: 24 * 60,
  day: 14 * 24 * 60,
};

const GRANULARITY_OPTIONS: { value: UsageGranularity; label: string }[] = [
  { value: "minute", label: "Minute" },
  { value: "hour", label: "Hour" },
  { value: "day", label: "Day" },
];

const KIND_OPTIONS: { value: CapabilityKind | ""; label: string }[] = [
  { value: "", label: "All kinds" },
  { value: "skill", label: "Skill" },
  { value: "mcp_tool", label: "MCP tool" },
];

const TIER_OPTIONS: { value: RiskTier | ""; label: string }[] = [
  { value: "", label: "All risk tiers" },
  { value: "read_only", label: "Read-only" },
  { value: "mutating", label: "Mutating" },
  { value: "destructive", label: "Destructive" },
];

const SOURCE_OPTIONS: { value: CapabilitySource | ""; label: string }[] = [
  { value: "", label: "All sources" },
  { value: "filesystem", label: "Filesystem" },
  { value: "mcp-manifest", label: "MCP manifest" },
  { value: "usage-history-only", label: "Usage history only" },
  { value: "manual", label: "Manual" },
];

const FILTERS_STORAGE_KEY = "dashboard-filters";

interface StoredFilters {
  granularity: UsageGranularity;
  windowMinutes: number;
  kind: CapabilityKind | "";
  riskTier: RiskTier | "";
  owner: string;
  source: CapabilitySource | "";
}

function loadStoredFilters(): Partial<StoredFilters> {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    // Corrupt or inaccessible storage (private browsing, etc.) — fall back to defaults.
    return {};
  }
}

export function DashboardPage() {
  const [stored] = useState(loadStoredFilters);
  const [granularity, setGranularity] = useState<UsageGranularity>(stored.granularity ?? "minute");
  const [windowMinutes, setWindowMinutes] = useState(
    stored.windowMinutes ?? DEFAULT_WINDOW_MINUTES[stored.granularity ?? "minute"],
  );
  const [kind, setKind] = useState<CapabilityKind | "">(stored.kind ?? "");
  const [riskTier, setRiskTier] = useState<RiskTier | "">(stored.riskTier ?? "");
  const [owner, setOwner] = useState(stored.owner ?? "");
  const [source, setSource] = useState<CapabilitySource | "">(stored.source ?? "");

  function selectGranularity(next: UsageGranularity) {
    setGranularity(next);
    setWindowMinutes(DEFAULT_WINDOW_MINUTES[next]);
  }

  // Persist filters so they survive a page refresh — restored via loadStoredFilters() above.
  useEffect(() => {
    const filters: StoredFilters = { granularity, windowMinutes, kind, riskTier, owner, source };
    try {
      localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
    } catch {
      // Storage unavailable (private browsing quota, etc.) — filters just won't persist.
    }
  }, [granularity, windowMinutes, kind, riskTier, owner, source]);

  const { data: capabilities } = useFetch(() => api.capabilities.list(), []);

  const ownerOptions = useMemo(
    () => Array.from(new Set((capabilities ?? []).map((c) => c.owner).filter(Boolean))).sort(),
    [capabilities],
  );

  const { data: summary, loading: loadingSummary, error: summaryError, reload: reloadSummary } = useFetch(
    () =>
      api.usage.summary({
        granularity,
        windowMinutes,
        capabilityKind: kind || undefined,
        riskTier: riskTier || undefined,
        capabilityOwner: owner || undefined,
        capabilitySource: source || undefined,
      }),
    [granularity, windowMinutes, kind, riskTier, owner, source],
  );
  const { data: drift, loading: loadingDrift, error: driftError, reload: reloadDrift } = useFetch(
    () => api.drift(),
    [],
  );
  const { data: principals, reload: reloadPrincipals } = useFetch(() => api.principals.list(), []);
  // Fetched deeper than the 25 rows the card used to show — the outcome tabs need enough rows
  // behind "All" for "Denied"/"Errors" to have something in them even when they're rare.
  const { data: recentEvents, reload: reloadRecentEvents } = useFetch(
    () => api.usage.list({ limit: 200 }),
    [],
  );

  const topPrincipals = useMemo(() => {
    const rows = (summary?.byPrincipal ?? []).slice().sort((a, b) => b.calls - a.calls).slice(0, 8);
    // Rows are per principal now, so two agents that drew the same platform nickname produce two
    // bars carrying the same label — qualify those with the agent id so they read as what they are.
    const nameCounts = new Map<string, number>();
    for (const p of rows) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
    return rows.map((p) => ({
      label:
        (nameCounts.get(p.name) ?? 0) > 1 ? `${p.name} (${p.agentName ?? p.principalId})` : p.name,
      value: p.calls,
    }));
  }, [summary]);

  const topCapabilities = useMemo(
    () =>
      (summary?.byCapability ?? [])
        .slice()
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 8)
        .map((c) => ({ label: c.name, value: c.calls })),
    [summary],
  );

  function refreshAfterInvoke() {
    reloadSummary();
    reloadDrift();
    reloadRecentEvents();
  }

  const principalNameById = useMemo(
    () => new Map((principals ?? []).map((p) => [p.id, p.humanName || p.name])),
    [principals],
  );
  const capabilityNameById = useMemo(
    () => new Map((capabilities ?? []).map((c) => [c.id, c.name])),
    [capabilities],
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Usage dashboard</h1>
          <p>What agents actually did, and what's stale or broken in the current grants.</p>
        </div>
      </div>

      <div className="filters">
        <label>
          X-axis granularity
          <select value={granularity} onChange={(e) => selectGranularity(e.target.value as UsageGranularity)}>
            {GRANULARITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Lookback window (minutes)
          <input
            type="number"
            min={1}
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))}
            style={{ width: 100 }}
          />
        </label>
        <label>
          Capability kind
          <select value={kind} onChange={(e) => setKind(e.target.value as CapabilityKind | "")}>
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Risk tier
          <select value={riskTier} onChange={(e) => setRiskTier(e.target.value as RiskTier | "")}>
            {TIER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Owner
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">All owners</option>
            {ownerOptions.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select value={source} onChange={(e) => setSource(e.target.value as CapabilitySource | "")}>
            {SOURCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {summaryError && <div className="error-banner">Could not load usage summary: {summaryError}</div>}
      {loadingSummary && <div className="loading">Loading usage summary…</div>}

      {summary && (
        <>
          <div className="stat-grid">
            <StatTile label="Total calls" value={summary.totals.calls.toLocaleString()} />
            <StatTile
              label="Denial rate"
              value={pct(summary.totals.denialRate)}
              sub={`${summary.totals.denied.toLocaleString()} denied`}
            />
            <StatTile label="Avg latency" value={`${Math.round(summary.totals.avgLatencyMs)}ms`} />
          </div>

          <div className="card">
            <h2>
              Latency breakdown <span className="muted">where the time goes, per phase</span>
            </h2>
            <div className="stat-grid">
              <StatTile
                label="Capability lookup"
                value={ms(summary.totals.avgCapabilityLookupMs)}
                sub="hook: resolve tool name → capability"
              />
              <StatTile
                label="Principal resolve"
                value={ms(summary.totals.avgPrincipalResolveMs)}
                sub="hook: identify the calling principal"
              />
              <StatTile
                label="Broker (grant check)"
                value={ms(summary.totals.avgBrokerMs)}
                sub="server: findActiveGrant itself"
              />
              <StatTile
                label="Grant check round trip"
                value={ms(summary.totals.avgGrantCheckMs)}
                sub="hook: full /invoke call, incl. network"
              />
              <StatTile
                label="Tool + harness"
                value={ms(summary.totals.avgLatencyMs)}
                sub="post-invoke to tool completion"
              />
            </div>
            <LatencyBreakdownChart data={summary.byBucket} granularity={summary.granularity} />
          </div>

          <div className="card">
            <h2>Calls over time</h2>
            <LineChart data={summary.byBucket} granularity={summary.granularity} />
          </div>

          <RecentCallsCard
            events={recentEvents}
            principalNameById={principalNameById}
            capabilityNameById={capabilityNameById}
          />

          <div className="dashboard-grid">
            <div className="card">
              <h2>Top principals by calls</h2>
              <BarChart data={topPrincipals} color="var(--series-1)" emptyLabel="No calls recorded yet." />
            </div>
            <div className="card">
              <h2>Top capabilities by calls</h2>
              <BarChart data={topCapabilities} color="var(--series-3)" emptyLabel="No calls recorded yet." />
            </div>
          </div>
        </>
      )}

      {/* Native harness tools (Read, Edit, Bash, ...) carry no capability, so nothing above this
          point can see them at all. Kept in its own card, below the governed views rather than
          folded into them, because these are unenforced observations off a best-effort spool and
          summing them with real broker decisions would misstate both. */}
      <NativeCallsCard />

      {/* Agent -> person, proposed from usage and confirmed by hand
          (docs/design/global-identity-and-central-db.md 1.6). Sits above Drift because an
          unowned agent is the more basic gap: drift asks whether a grant is still earning its
          keep, this asks who is accountable for the calls at all. */}
      <OwnerProposalsCard onDecided={reloadPrincipals} />

      <div className="card">
        <h2>
          Drift <span className="muted">unused grants &amp; high-denial capabilities</span>
        </h2>
        {driftError && <div className="error-banner">Could not load drift report: {driftError}</div>}
        {loadingDrift && <div className="loading">Loading drift report…</div>}
        {drift && (
          <div className="dashboard-grid">
            <div>
              <h3 style={{ fontSize: 12, margin: "0 0 8px" }}>
                Unused grants <span className="muted">(&gt;90d idle, {drift.unusedGrants.length})</span>
              </h3>
              {drift.unusedGrants.length === 0 ? (
                <div className="empty-state">No grant has been idle for more than 90 days.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Principal</th>
                      <th>Capability</th>
                      <th>Granted</th>
                      <th>Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drift.unusedGrants.map((g) => (
                      <tr key={g.grantId}>
                        <td>{g.principalName}</td>
                        <td>{g.capabilityName}</td>
                        <td className="muted">{new Date(g.grantedAt).toLocaleDateString()}</td>
                        <td className="muted">
                          {g.lastUsedAt === g.grantedAt ? "never" : new Date(g.lastUsedAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <h3 style={{ fontSize: 12, margin: "0 0 8px" }}>
                High-denial capabilities <span className="muted">({drift.highDenial.length})</span>
              </h3>
              {drift.highDenial.length === 0 ? (
                <div className="empty-state">No capability is being denied at a high rate.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Capability</th>
                      <th>Denial rate</th>
                      <th>Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drift.highDenial.map((c) => (
                      <tr key={c.capabilityId}>
                        <td>{c.name}</td>
                        <td>
                          <span className="badge badge-denied">{pct(c.denialRate)}</span>
                        </td>
                        <td className="muted tabular">{c.calls}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>

      <InvokePanel
        principals={principals ?? []}
        capabilities={capabilities ?? []}
        onInvoked={refreshAfterInvoke}
      />
    </div>
  );
}
