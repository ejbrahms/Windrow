import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { useFetch } from "../api/useFetch";
import type { CapabilityKind, DiscoveryLastResult, RiskTier } from "../api/types";
import { KindPill, RiskBadge, SourceTag } from "../components/Badge";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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

export function CatalogPage() {
  const { data, loading, error, reload } = useFetch(() => api.capabilities.list(), []);
  const [kind, setKind] = useState<CapabilityKind | "">("");
  const [tier, setTier] = useState<RiskTier | "">("");

  const [lastRun, setLastRun] = useState<DiscoveryLastResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  // Discovery may genuinely have never run (fresh install) — a 404 there means "no result",
  // not a failure to surface.
  useEffect(() => {
    api.discovery
      .last()
      .then(setLastRun)
      .catch((err: unknown) => {
        if (!(err instanceof ApiError && err.status === 404)) {
          setRunError(err instanceof Error ? err.message : String(err));
        }
      });
  }, []);

  function runDiscovery() {
    setRunning(true);
    setRunError(null);
    api.discovery
      .run()
      .then((result) => {
        setLastRun({ ...result, ranAt: new Date().toISOString() });
        reload();
      })
      .catch((err: unknown) => setRunError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRunning(false));
  }

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.filter((c) => (kind === "" || c.kind === kind) && (tier === "" || c.riskTier === tier));
  }, [data, kind, tier]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Capability catalog</h1>
          <p>Every skill and MCP tool registered with the broker — what an agent could do.</p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load capabilities: {error}</div>}
      {runError && <div className="error-banner">Discovery run failed: {runError}</div>}

      <div className="card">
        <div className="discovery-bar">
          <button className="btn btn-primary" onClick={runDiscovery} disabled={running}>
            {running ? "Scanning…" : "Run discovery"}
          </button>
          {lastRun ? (
            <div className="discovery-summary">
              <span>Last run {formatDate(lastRun.ranAt)}:</span>
              <span className="stat">
                <strong>{lastRun.added.length}</strong> added
              </span>
              <span className="stat">
                <strong>{lastRun.updated.length}</strong> updated
              </span>
              <span className="stat">
                <strong>{lastRun.staled.length}</strong> newly stale
              </span>
              {(lastRun.added.length > 0 || lastRun.staled.length > 0) && (
                <button className="btn" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => setShowDetail((v) => !v)}>
                  {showDetail ? "Hide" : "Details"}
                </button>
              )}
            </div>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              Discovery hasn't run yet — scans real skill directories and the MCP tool manifest.
            </span>
          )}
        </div>
        {showDetail && lastRun && (lastRun.added.length > 0 || lastRun.staled.length > 0) && (
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {lastRun.added.length > 0 && (
              <div>
                <strong>Added:</strong> {lastRun.added.map((c) => c.name).join(", ")}
              </div>
            )}
            {lastRun.staled.length > 0 && (
              <div>
                <strong>Newly stale:</strong> {lastRun.staled.map((c) => c.name).join(", ")}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="filters">
        <label>
          Kind
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
          <select value={tier} onChange={(e) => setTier(e.target.value as RiskTier | "")}>
            {TIER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {data && (
          <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
            {filtered.length} of {data.length} capabilities
          </span>
        )}
      </div>

      <div className="card">
        {loading && <div className="loading">Loading capabilities…</div>}
        {!loading && filtered.length === 0 && !error && (
          <div className="empty-state">No capabilities match these filters.</div>
        )}
        {!loading && filtered.length > 0 && (
          <table className="cap-table">
            <colgroup>
              <col style={{ width: "18%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "44%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Owner</th>
                <th>Risk tier</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className={c.stale ? "stale-row" : undefined}>
                  <td>
                    <strong>{c.name}</strong>
                    {c.stale && <span className="stale-label">STALE</span>}
                    {c.realUsage && (
                      <div className="real-usage">
                        used {c.realUsage.usageCount}× · last {formatDate(c.realUsage.lastUsedAt)}
                      </div>
                    )}
                  </td>
                  <td>
                    <KindPill kind={c.kind} />
                    <SourceTag source={c.source} />
                  </td>
                  <td className="muted">{c.owner}</td>
                  <td>
                    <RiskBadge tier={c.riskTier} />
                  </td>
                  <td className="muted">{c.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
