import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fleet } from "../../api/fleet";
import type { FleetEvent } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { AssuranceBadge } from "../../components/Badge";
import { LineChart } from "../../components/LineChart";
import { LatencyBreakdownChart } from "../../components/LatencyBreakdownChart";
import { FLEET_WINDOWS, WindowPicker, count, list, shortId, when } from "./shared";

/**
 * The live tail — `GET /api/fleet/events`, the most recent governed decisions the whole fleet has
 * shipped.
 *
 * THE TWO TIMES ARE BOTH SHOWN AND THEY ARE NOT THE SAME CLAIM. `observedAt` is central's own
 * clock, stamped at ingest, and it is what the table is ordered by. `ts` is when the *calling
 * machine* said the call happened. Their difference is `clockSkewMs`, which central computes and
 * stores rather than leaving to be derived — §2.3: "skew is what turns an audit log into
 * plausible-looking fiction". A row with a large skew is not necessarily wrong, but it is a row
 * whose own account of when it happened rests on a clock nobody here controls.
 *
 * OUTCOME MAY BE ABSENT, AND ABSENT IS NOT `ok`. A build that ships no outcome column at all
 * leaves it null, and rendering that as allowed would turn a schema skew into a clean bill of
 * health for calls nobody can account for.
 */

const OUTCOME_TONE: Record<string, string> = {
  ok: "badge-ok",
  approved: "badge-approved",
  denied: "badge-denied",
  error: "badge-error",
};

function actorOf(e: FleetEvent): string {
  return e.actorLoomId ?? e.actorAgentType ?? e.osUser ?? "—";
}

export function FleetEventsPage() {
  const [nodeId, setNodeId] = useState("");
  const [limit, setLimit] = useState(100);
  const [onlyProblems, setOnlyProblems] = useState(false);
  // The window drives the two charts only; the table below is a fixed-row tail, not a windowed
  // query. The node filter is shared between them — narrowing to one node narrows both.
  const [range, setRange] = useState(FLEET_WINDOWS[1]);
  const roster = useFetch(() => fleet.nodes(), []);
  const { data, loading, error, reload } = useFetch(
    () => fleet.events({ nodeId: nodeId || undefined, limit }),
    [nodeId, limit],
  );

  // Granularity follows the window rather than being a second control — the choice every other
  // fleet chart makes (see FleetNativePage): an hour wants minutes, a month wants hours, and
  // offering both knobs is how someone asks for 43,200 one-minute buckets the server then truncates.
  const series = useFetch(
    () =>
      fleet.usageSeries({
        granularity: range.hours <= 1 ? "minute" : "hour",
        windowMinutes: range.hours * 60,
        nodeId: nodeId || undefined,
      }),
    [range.hours, nodeId],
  );

  const events = useMemo(() => {
    const all = list(data?.events);
    if (!onlyProblems) return all;
    return all.filter((e) => e.outcome === "denied" || e.outcome === "error" || e.outcome === null);
  }, [data, onlyProblems]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Fleet events</h1>
          <p>
            The newest governed decisions from every node, newest first. Ordered on central's
            arrival clock — the one clock in this system that is not a user's PC.
          </p>
        </div>
        <div className="live-control">
          <WindowPicker value={range} onChange={setRange} label="Chart window" />
        </div>
      </div>

      <div className="filters">
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
        <label>
          Rows
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[50, 100, 250, 500, 1000].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={"tab" + (onlyProblems ? " active" : "")}
          aria-pressed={onlyProblems}
          onClick={() => setOnlyProblems((v) => !v)}
        >
          Denied, errored or unrecorded
        </button>
        <button type="button" className="btn" onClick={reload}>
          Refresh
        </button>
      </div>

      {error && <div className="error-banner">Could not load fleet events: {error}</div>}
      {loading && <div className="loading">Loading the fleet's most recent events…</div>}

      {/*
        CALLS OVER TIME AND WHERE THE TIME WENT — the same two charts the node dashboard drew from
        `/api/usage/summary`, restored here from central's `/api/fleet/usage/series`. They read the
        node's `UsageBucket` shape unchanged, so this is a data source, not a second pair of charts.

        WINDOWED, NOT TAILED. Both are cut over the chart window on `observedAt` — central's own
        clock, the one §2.3 lets it answer with — independent of the table's row cap below. A spike
        here is a node draining a backlog into one arrival hour, not a burst that happened; the
        header's clock note is why.
      */}
      <div className="card">
        <h2>Calls over time</h2>
        {series.error && <div className="error-banner">Could not load the series: {series.error}</div>}
        {series.loading && !series.data && <div className="loading">Loading the series…</div>}
        {series.data && <LineChart data={series.data.byBucket} granularity={series.data.granularity} />}
      </div>

      <div className="card">
        <h2>
          Latency breakdown <span className="muted">where the time goes, per phase</span>
        </h2>
        {series.error && <div className="error-banner">Could not load the series: {series.error}</div>}
        {series.loading && !series.data && <div className="loading">Loading the series…</div>}
        {series.data && (
          <LatencyBreakdownChart data={series.data.byBucket} granularity={series.data.granularity} />
        )}
      </div>

      <div className="card">
        {events.length === 0 ? (
          <div className="empty-state">
            {onlyProblems
              ? "Nothing denied, errored or unrecorded in the rows fetched."
              : "Central holds no events yet."}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Central saw</th>
                <th>Node</th>
                <th>Principal</th>
                <th>Capability</th>
                <th>Outcome</th>
                <th>Actor</th>
                <th>Assurance</th>
                <th>Latency</th>
                <th>Skew</th>
                <th>Seq</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={`${e.nodeId}:${e.id}`}>
                  <td className="muted" title={e.ts ? `node said ${e.ts}` : undefined}>
                    {when(e.observedAt)}
                  </td>
                  <td>
                    <Link to={`/fleet/nodes/${encodeURIComponent(e.nodeId)}`}>
                      <code>{shortId(e.nodeId, 12)}</code>
                    </Link>
                  </td>
                  <td className="muted">
                    {/* The name when central can resolve it, the id when it cannot — see
                        FleetUsagePage for why the id is never dropped entirely. */}
                    <code title={e.principalId ?? undefined}>
                      {e.principalLabel ?? e.principalId ?? "—"}
                    </code>
                    {e.subjectId && <div className="muted">{e.subjectId}</div>}
                  </td>
                  <td className="muted">
                    <code title={e.capabilityId ?? undefined}>
                      {e.capabilityLabel ?? e.capabilityId ?? "—"}
                    </code>
                  </td>
                  <td>
                    {e.outcome ? (
                      <span className={`badge ${OUTCOME_TONE[e.outcome] ?? ""}`}>{e.outcome}</span>
                    ) : (
                      <span className="badge badge-error" title="This build shipped no outcome column — §2.6 schema skew, not a permitted call">
                        Not recorded
                      </span>
                    )}
                    {e.reason && <div className="muted">{e.reason}</div>}
                  </td>
                  <td className="muted">{actorOf(e)}</td>
                  <td>
                    <AssuranceBadge level={e.assuranceLevel} />
                  </td>
                  <td className="muted tabular">{e.latencyMs === null ? "—" : `${e.latencyMs} ms`}</td>
                  <td className="muted tabular">
                    {e.clockSkewMs === null ? "—" : `${e.clockSkewMs.toLocaleString()} ms`}
                  </td>
                  <td className="muted tabular" title={e.incarnation ?? undefined}>
                    {count(e.seq)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
