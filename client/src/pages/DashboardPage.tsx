import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useFetch } from "../api/useFetch";
import type {
  CapabilityKind,
  CapabilitySource,
  RiskTier,
  UsageEvent,
  UsageGranularity,
} from "../api/types";
import { StatTile } from "../components/StatTile";
import { LineChart } from "../components/LineChart";
import { LatencyBreakdownChart } from "../components/LatencyBreakdownChart";
import { BarChart } from "../components/BarChart";
import { RecentCallsCard } from "../components/RecentCallsCard";
import { LiveControl } from "../components/LiveControl";
import { useAutoRefresh } from "../hooks/useAutoRefresh";

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
const AUTO_REFRESH_STORAGE_KEY = "dashboard-auto-refresh";

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
  const { data: principals } = useFetch(() => api.principals.list(), []);

  // Recent calls are fetched a page at a time rather than through useFetch: the outcome tabs need
  // depth behind "All" for rare "Denied"/"Errors" to have anything in them, and past the RECENT_LIMIT
  // cap the "Load older" control fetches the next page with a `before=` cursor and appends it here.
  // A full-return page (length === RECENT_LIMIT) is the signal there may be more to load.
  const RECENT_LIMIT = 200;
  const [recentEvents, setRecentEvents] = useState<UsageEvent[] | null>(null);
  const [loadingRecent, setLoadingRecent] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreRecent, setHasMoreRecent] = useState(false);

  const reloadRecentEvents = useCallback(() => {
    setLoadingRecent(true);
    api.usage
      .list({ limit: RECENT_LIMIT })
      .then((events) => {
        setRecentEvents(events);
        setHasMoreRecent(events.length === RECENT_LIMIT);
      })
      .catch(() => {
        // The summary error banner already covers a dead API; the card just falls back to empty.
      })
      .finally(() => setLoadingRecent(false));
  }, []);

  useEffect(() => {
    reloadRecentEvents();
  }, [reloadRecentEvents]);

  const loadOlderRecent = useCallback(() => {
    // Rows are newest-first, so the last one is the oldest we hold — its `ts` is the cursor.
    const oldest = recentEvents?.[recentEvents.length - 1];
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    api.usage
      .list({ limit: RECENT_LIMIT, before: oldest.ts })
      .then((older) => {
        setRecentEvents((prev) => [...(prev ?? []), ...older]);
        setHasMoreRecent(older.length === RECENT_LIMIT);
      })
      .catch(() => {
        // Leave what we have on screen; the button stays available to retry.
      })
      .finally(() => setLoadingOlder(false));
  }, [recentEvents, loadingOlder]);

  const reloadAll = () => {
    reloadSummary();
    reloadRecentEvents();
  };
  const auto = useAutoRefresh({
    storageKey: AUTO_REFRESH_STORAGE_KEY,
    reload: reloadAll,
    dataSignal: summary,
  });

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

  const principalNameById = useMemo(
    () => new Map((principals ?? []).map((p) => [p.id, p.humanName || p.name])),
    [principals],
  );
  const capabilityNameById = useMemo(
    () => new Map((capabilities ?? []).map((c) => [c.id, c.name])),
    [capabilities],
  );

  // Count of the four narrowing filters that are set, for the collapsed disclosure's label —
  // otherwise a filter left on last week silently explains a chart that looks wrong today.
  const extraFilterCount = [kind, riskTier, owner, source].filter(Boolean).length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Overview</h1>
          <p>What agents actually did, as the broker saw it.</p>
        </div>
        <LiveControl auto={auto} onRefresh={reloadAll} />
      </div>

      {/* Granularity is the one control people reach for, so it stays a visible row; the four
          that narrow *which* calls count are behind a disclosure that says how many are on. */}
      <div className="overview-controls">
        <div className="tabs granularity-tabs" role="group" aria-label="X-axis granularity">
          {GRANULARITY_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={"tab" + (granularity === o.value ? " active" : "")}
              aria-pressed={granularity === o.value}
              onClick={() => selectGranularity(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <label className="window-field">
          Last
          <input
            type="number"
            min={1}
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(Math.max(1, parseInt(e.target.value, 10) || 1))}
          />
          min
        </label>
        <details className="filter-disclosure">
          <summary>
            Filters
            {extraFilterCount > 0 && <span className="tab-count"> {extraFilterCount} on</span>}
          </summary>
          <div className="filters">
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
        </details>
      </div>

      {summaryError && <div className="error-banner">Could not load usage summary: {summaryError}</div>}
      {/* Only while the page is still empty. On an auto-refresh the numbers are already on screen,
          and swapping them for a loading line every ten seconds is the flicker this avoids. */}
      {loadingSummary && !summary && <div className="loading">Loading usage summary…</div>}

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
            <StatTile
              label="Active agents"
              value={(summary.byPrincipal ?? []).length.toLocaleString()}
              sub={`${(summary.byCapability ?? []).length} capabilities used`}
            />
          </div>

          <div className="card">
            <h2>Calls over time</h2>
            <LineChart data={summary.byBucket} granularity={summary.granularity} />
          </div>

          <div className="dashboard-grid">
            <div className="card">
              <h2>Top agents by calls</h2>
              <BarChart data={topPrincipals} color="var(--series-1)" emptyLabel="No calls recorded yet." />
            </div>
            <div className="card">
              <h2>Top capabilities by calls</h2>
              <BarChart data={topCapabilities} color="var(--series-3)" emptyLabel="No calls recorded yet." />
            </div>
          </div>

          <RecentCallsCard
            events={recentEvents}
            loading={loadingRecent}
            loadingOlder={loadingOlder}
            hasMore={hasMoreRecent}
            onLoadOlder={loadOlderRecent}
            principalNameById={principalNameById}
            capabilityNameById={capabilityNameById}
          />

          {/* Five tiles and a stacked chart answering "which phase is slow" — a real question, but
              one asked after the headline latency looks wrong, not before. Folded shut so the
              page opens on the numbers people came for. */}
          <details className="card card-disclosure">
            <summary>
              <h2>
                Latency breakdown <span className="muted">where the time goes, per phase</span>
              </h2>
            </summary>
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
          </details>
        </>
      )}
    </div>
  );
}
