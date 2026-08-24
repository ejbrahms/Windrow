import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fleet } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { StatTile } from "../../components/StatTile";
import { count, list, when } from "./shared";

/**
 * What has fired, from either end — `GET /api/fleet/alerts`.
 *
 * `firedBy` IS THE COLUMN TO READ FIRST, and it is why this table leads with it rather than with
 * severity. A row that says **node** means a machine caught the breach itself, possibly while it
 * could not reach central at all; a row that says **central** means nobody knew until the events
 * landed here. Same alert, very different operational story — and it is the one column that
 * cannot be reconstructed after the fact.
 *
 * `peerValue` IS THE SECOND. When both ends fire the same key, the second write cannot change
 * `value` — the row is already there — but the two counts disagreeing is a real signal: the node
 * and central were looking at different sets of rows for the same window. That is either shipping
 * lag, where the size of the gap is the interesting number, or a node whose stream has a hole in
 * it. Discarding the loser's count would make the difference permanently undetectable, so it is
 * kept, and so it is shown.
 */

const SEVERITY_TONE: Record<string, string> = {
  critical: "badge-denied",
  high: "badge-denied",
  warning: "badge-error",
  medium: "badge-error",
  info: "badge-ok",
  low: "badge-ok",
};

const SEVERITIES = ["", "critical", "high", "warning", "info"];

export function FleetAlertsPage() {
  const [severity, setSeverity] = useState("");
  const [nodeId, setNodeId] = useState("");
  const roster = useFetch(() => fleet.nodes(), []);
  const { data, loading, error, reload } = useFetch(
    () => fleet.alerts({ limit: 200, severity: severity || undefined, nodeId: nodeId || undefined }),
    [severity, nodeId],
  );

  const alerts = useMemo(() => list(data?.alerts), [data]);
  const engine = data?.engine;
  const rules = list(engine?.rules);
  const byNodeEnd = alerts.filter((a) => a.firedBy === "node").length;
  const disagreed = alerts.filter((a) => a.peerValue !== null && a.peerValue !== a.value).length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Alerts</h1>
          <p>
            Threshold breaches, from whichever end saw them first. A node fires against its own
            events even when it cannot reach central; central fires against everything that has
            landed. The same breach seen by both is one alert, deduplicated on a shared key.
          </p>
        </div>
      </div>

      <div className="filters">
        <label>
          Severity
          <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            {SEVERITIES.map((s) => (
              <option key={s || "all"} value={s}>
                {s === "" ? "Any severity" : s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Node
          <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
            <option value="">Every node</option>
            {(roster.data?.nodes ?? []).map((n) => (
              <option key={n.nodeId} value={n.nodeId}>
                {n.hostname ?? n.nodeId}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn" onClick={reload}>
          Refresh
        </button>
      </div>

      {error && <div className="error-banner">Could not load alerts: {error}</div>}
      {loading && <div className="loading">Loading alerts…</div>}

      {data && (
        <div className="stat-grid">
          <StatTile
            label="Alerts shown"
            value={count(alerts.length)}
            sub={`${byNodeEnd} caught by a node itself`}
          />
          <StatTile
            label="Ends disagreed"
            value={count(disagreed)}
            sub="node and central counted the same window differently"
          />
          {engine && (
            <StatTile
              label="Central's sweep"
              value={engine.running ? "Running" : "Stopped"}
              sub={`${count(engine.sweeps)} sweeps · ${count(engine.fired)} fired · ${count(engine.deduped)} deduped`}
            />
          )}
          {engine && (
            <StatTile
              label="Rules active"
              value={count(rules.length)}
              sub={`${count(engine.suppressed)} suppressed by cooldown · ${count(engine.errors)} errors`}
            />
          )}
        </div>
      )}

      <div className="card">
        <h2>Fired</h2>
        {alerts.length === 0 ? (
          <div className="empty-state">
            Nothing has fired that matches. An empty alerts table is the intended steady state.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Fired</th>
                <th>Caught by</th>
                <th>Severity</th>
                <th>Rule</th>
                <th>Subject</th>
                <th>Node</th>
                <th>Measured</th>
                <th>Window</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.key}>
                  <td className="muted" title={`central recorded it ${when(a.recordedAt)}`}>
                    {when(a.firedAt)}
                  </td>
                  <td>
                    <span className={`badge ${a.firedBy === "node" ? "badge-ok" : "badge-error"}`}>
                      {a.firedBy === "node" ? "The node" : "Central"}
                    </span>
                    {a.peerFiredBy && (
                      <div className="muted">
                        also seen by {a.peerFiredBy}
                        {a.peerValue !== null && a.peerValue !== a.value && ` at ${a.peerValue}`}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${SEVERITY_TONE[a.severity] ?? ""}`}>{a.severity}</span>
                  </td>
                  <td>
                    {a.title ?? a.ruleId}
                    <div className="muted">
                      <code>{a.ruleId}</code> · {a.scope}
                    </div>
                  </td>
                  <td className="muted">
                    <code>{a.subjectId}</code>
                  </td>
                  <td className="muted">
                    {a.nodeId ? (
                      <Link to={`/fleet/nodes/${encodeURIComponent(a.nodeId)}`}>
                        <code>{a.nodeId}</code>
                      </Link>
                    ) : (
                      "fleet-wide"
                    )}
                  </td>
                  <td className="tabular">
                    {a.value}
                    <div className="muted">
                      {a.metric} ≥ {a.threshold}
                    </div>
                  </td>
                  <td className="muted">
                    {Math.round(a.windowMs / 1000)}s to {when(a.windowEnd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {engine && rules.length > 0 && (
        <div className="card">
          <h2>Rules central is sweeping</h2>
          <table>
            <thead>
              <tr>
                <th>Rule</th>
                <th>Scope</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>{r.id}</code>
                  </td>
                  <td className="muted">{r.scope}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            A fleet-scoped rule owns no single machine — that is the point of it — so its alerts
            carry no node id. A node-scoped rule fires per machine, because the same subject
            bursting on two PCs is two incidents rather than a duplicate.
          </p>
        </div>
      )}
    </div>
  );
}
