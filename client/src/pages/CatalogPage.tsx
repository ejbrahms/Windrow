import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { useFetch } from "../api/useFetch";
import type { Capability, DiscoveryLastResult } from "../api/types";
import { KindPill, RiskBadge, SourceTag } from "../components/Badge";
import { CapabilityFilterBar, useCapabilityFilters } from "../components/CapabilityFilters";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CatalogPage() {
  const { data, loading, error, reload } = useFetch(() => api.capabilities.list(), []);
  const { data: packages } = useFetch(() => api.packages.list(), []);
  const filters = useCapabilityFilters(data, packages);

  const [lastRun, setLastRun] = useState<DiscoveryLastResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [pendingAutoGrant, setPendingAutoGrant] = useState<Set<string>>(new Set());
  const [autoGrantError, setAutoGrantError] = useState<string | null>(null);

  // F5 (docs/design/governance-review-2026-08-16.md) — autoGrant bypasses the grant table
  // entirely, so it's surfaced and toggled right here rather than hidden behind an owner string.
  // Destructive capabilities can never carry it; the server refuses the write, this just keeps the
  // control itself from being offered as if it would do something.
  function toggleAutoGrant(capability: Capability, next: boolean) {
    if (capability.riskTier === "destructive") return;
    setAutoGrantError(null);
    setPendingAutoGrant((p) => new Set(p).add(capability.id));
    api.capabilities
      .setAutoGrant(capability.id, next)
      .then(() => reload())
      .catch((err: unknown) => setAutoGrantError(err instanceof ApiError ? err.message : String(err)))
      .finally(() =>
        setPendingAutoGrant((p) => {
          const copy = new Set(p);
          copy.delete(capability.id);
          return copy;
        })
      );
  }

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

  const filtered = filters.filtered;

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
      {autoGrantError && <div className="error-banner">{autoGrantError}</div>}

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

      <CapabilityFilterBar
        state={filters}
        packages={packages}
        countLabel={data ? `${filtered.length} of ${data.length} capabilities` : undefined}
      />

      <div className="card">
        {loading && <div className="loading">Loading capabilities…</div>}
        {!loading && filtered.length === 0 && !error && (
          <div className="empty-state">No capabilities match these filters.</div>
        )}
        {!loading && filtered.length > 0 && (
          <table className="cap-table">
            <colgroup>
              <col style={{ width: "16%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "39%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Owner</th>
                <th>Risk tier</th>
                <th>Auto-grant</th>
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
                  <td>
                    {c.riskTier === "destructive" ? (
                      <span className="muted" title="Destructive capabilities can never be auto-granted.">
                        —
                      </span>
                    ) : (
                      <label className="auto-grant-toggle">
                        <input
                          type="checkbox"
                          checked={!!c.autoGranted}
                          disabled={pendingAutoGrant.has(c.id)}
                          onChange={(e) => toggleAutoGrant(c, e.target.checked)}
                        />
                        {c.autoGranted ? "On" : "Off"}
                      </label>
                    )}
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
