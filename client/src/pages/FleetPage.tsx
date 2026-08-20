import { useMemo } from "react";
import { api } from "../api/client";
import { useFetch } from "../api/useFetch";
import { StatTile } from "../components/StatTile";
import { BarChart } from "../components/BarChart";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

// docs/design/cross-field-and-standalone.md — the two things the per-workspace Dashboard page
// structurally can't show: usage merged across every workspace, and usage from standalone
// Claude/agy/codex sessions that never ran under a tracked agent instance at all.
//
// TWO SOURCES, AND THIS PAGE SAYS WHICH IT GOT (§2.7 phase 5). `central` is one query across every
// node that has reported; `local-scan` is this machine's workspace directories read off disk. They
// answer different questions — "the fleet" and "this PC" — so the scope is stated in the header
// rather than left for a reader to assume from the word Fleet.
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
  // Both endpoints carry the same provenance; the summary is the one whose numbers are quoted in
  // the tiles, so it wins where they could differ (a central that answered one request and failed
  // the next).
  const source = summary?.source ?? fields?.source ?? null;
  const centralError = summary?.centralError ?? fields?.centralError ?? null;
  const scopedToOneNode = (summary?.scope?.nodeIds?.length ?? 0) > 0;

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
            {source === "central"
              ? scopedToOneNode
                ? "Usage from the central store, scoped to this node's own events — this node's certificate reaches only its own rows."
                : "Usage from the central store, merged across every node that has reported."
              : "Usage merged across every workspace found on this machine — one read-only pass over each workspace's database, no shared write path."}
            {" "}Plus standalone Claude / Antigravity / Codex sessions that never ran under a tracked
            agent instance at all. See <code>docs/design/cross-field-and-standalone.md</code>.
          </p>
        </div>
      </div>

      {centralError && (
        <div className="error-banner">
          Central could not be queried, so these numbers are this machine only: {centralError}
        </div>
      )}
      {(fieldsError || summaryError) && (
        <div className="error-banner">
          Could not load rollup: {fieldsError ?? summaryError}
        </div>
      )}
      {(loadingFields || loadingSummary) && <div className="loading">Loading fleet rollup…</div>}

      {summary && (
        <div className="stat-grid">
          <StatTile
            label={source === "central" ? "Total calls (fleet + standalone)" : "Total calls (this machine + standalone)"}
            value={summary.totals.calls.toLocaleString()}
            sub={
              source === "central" && summary.totals.nodes != null
                ? `${summary.totals.nodes.toLocaleString()} node${summary.totals.nodes === 1 ? "" : "s"} reporting`
                : undefined
            }
          />
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
            {fields.root ? (
              <>
                No workspaces found under <code>{fields.root}</code>.
              </>
            ) : (
              "No workspace has reported usage to the central store yet."
            )}
          </div>
        )}
        {fields && fields.fields.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Workspace</th>
                {source !== "central" && <th>Reachable</th>}
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
                  {source !== "central" && (
                    <td>
                      {f.reachable ? (
                        <span className="badge badge-ok">Reachable</span>
                      ) : (
                        <span className="badge badge-denied" title={f.error ?? undefined}>
                          Unreachable
                        </span>
                      )}
                    </td>
                  )}
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
                <tr key={`${p.principalId}:${p.field ?? p.backend}`}>
                  <td>
                    {p.name}
                    {p.agentName && p.agentName !== p.name && (
                      <>
                        {" "}
                        <code className="muted">{p.agentName}</code>
                      </>
                    )}
                  </td>
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
