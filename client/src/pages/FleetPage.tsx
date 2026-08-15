import { useMemo } from "react";
import { api } from "../api/client";
import { useFetch } from "../api/useFetch";
import { StatTile } from "../components/StatTile";
import { BarChart } from "../components/BarChart";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// docs/design/cross-field-and-standalone.md — the two things the per-workspace Dashboard page
// structurally can't show: usage merged across every workspace on this machine, and usage from
// standalone Claude/agy/codex sessions that never ran under a tracked agent instance at all.
export function FleetPage() {
  const { data: fields, loading: loadingFields, error: fieldsError } = useFetch(
    () => api.rollup.fields(),
    [],
  );
  const { data: summary, loading: loadingSummary, error: summaryError } = useFetch(
    () => api.rollup.summary(),
    [],
  );

  const byFieldBars = useMemo(
    () => (summary?.byField ?? []).map((f) => ({ label: f.field, value: f.calls })),
    [summary],
  );
  const byBackendBars = useMemo(
    () => (summary?.standalone.byBackend ?? []).map((b) => ({ label: b.backend, value: b.calls })),
    [summary],
  );
  const topPrincipals = useMemo(
    () =>
      (summary?.byPrincipal ?? [])
        .slice()
        .sort((a, b) => b.calls - a.calls)
        .slice(0, 10),
    [summary],
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Fleet</h1>
          <p>
            Usage merged across every workspace found on this machine, plus standalone
            Claude / Antigravity / Codex sessions that never ran under a tracked agent instance at all — read-only,
            no shared write path. See{" "}
            <code>docs/design/cross-field-and-standalone.md</code>.
          </p>
        </div>
      </div>

      {(fieldsError || summaryError) && (
        <div className="error-banner">
          Could not load rollup: {fieldsError ?? summaryError}
        </div>
      )}
      {(loadingFields || loadingSummary) && <div className="loading">Loading fleet rollup…</div>}

      {summary && (
        <div className="stat-grid">
          <StatTile label="Total calls (all workspaces + standalone)" value={summary.totals.calls.toLocaleString()} />
          <StatTile
            label="Denial rate"
            value={pct(summary.totals.denialRate)}
            sub={`${summary.totals.denied.toLocaleString()} denied`}
          />
          <StatTile
            label="Standalone calls"
            value={summary.standalone.calls.toLocaleString()}
            sub={`${summary.standalone.denied.toLocaleString()} denied`}
          />
        </div>
      )}

      <div className="card">
        <h2>Workspaces discovered</h2>
        {fields && fields.fields.length === 0 && (
          <div className="empty-state">
            No workspaces found under <code>{fields.root}</code>.
          </div>
        )}
        {fields && fields.fields.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Reachable</th>
                <th>Principals</th>
                <th>Events</th>
                <th>Last event</th>
              </tr>
            </thead>
            <tbody>
              {fields.fields.map((f) => (
                <tr key={f.field}>
                  <td>
                    {f.field}
                    {f.field === fields.thisField && <span className="muted"> (this workspace)</span>}
                    {f.sharedOnly && (
                      <span className="muted" title="Discovered from principal data inside another workspace's shared db — no governance.db of its own on this machine">
                        {" "}(shared)
                      </span>
                    )}
                  </td>
                  <td>
                    {f.reachable ? (
                      <span className="badge badge-ok">Reachable</span>
                    ) : (
                      <span className="badge badge-denied" title={f.error ?? undefined}>
                        Unreachable
                      </span>
                    )}
                  </td>
                  <td className="muted tabular">{f.principalCount}</td>
                  <td className="muted tabular">{f.eventCount}</td>
                  <td className="muted">
                    {f.lastEventAt ? new Date(f.lastEventAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="dashboard-grid">
        <div className="card">
          <h2>Calls by workspace</h2>
          <BarChart data={byFieldBars} color="var(--series-1)" emptyLabel="No cross-workspace calls recorded yet." />
        </div>
        <div className="card">
          <h2>Standalone calls by backend</h2>
          <BarChart data={byBackendBars} color="var(--series-2)" emptyLabel="No standalone usage recorded yet." />
        </div>
      </div>

      <div className="card">
        <h2>Top principals across the fleet</h2>
        {topPrincipals.length === 0 ? (
          <div className="empty-state">No calls recorded yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Principal</th>
                <th>Where</th>
                <th>Calls</th>
                <th>Denied</th>
              </tr>
            </thead>
            <tbody>
              {topPrincipals.map((p) => (
                <tr key={`${p.name}:${p.field ?? p.backend}`}>
                  <td>{p.name}</td>
                  <td className="muted">
                    {p.standalone ? `standalone (${p.backend})` : p.field}
                  </td>
                  <td className="tabular">{p.calls}</td>
                  <td className="muted tabular">{p.denied}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
