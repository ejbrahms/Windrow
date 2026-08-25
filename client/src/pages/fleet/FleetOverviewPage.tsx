import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fleet, num } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { BarChart } from "../../components/BarChart";
import { StatTile } from "../../components/StatTile";
import { LiveControl } from "../../components/LiveControl";
import { useHost } from "../../hooks/useHost";
import { useAutoRefresh } from "../../hooks/useAutoRefresh";
import { FLEET_WINDOWS, WindowPicker, count, list, pct, when } from "./shared";

/**
 * The fleet's headline numbers — `GET /api/fleet/summary`.
 *
 * WINDOWED ON CENTRAL'S OWN CLOCK, and the header says so. The route filters on `observedAt`,
 * which is when central saw the event, not on `ts`, which is when a node claims it happened.
 * "What did central see in the last 24 hours" is a question one clock can answer; "what happened
 * in the last 24 hours" would depend on N node clocks that §2.3 says to trust for nothing. A
 * dashboard that quietly labelled the first as the second would be the most plausible-looking
 * wrong number on the whole page.
 *
 * TWO TOTALS ARE NOT TRAFFIC AND ARE PLACED WHERE THEY WILL BE READ: `outcomeUnrecorded` counts
 * rows an unfamiliar build shipped with no outcome at all, and `withUnknownFields` counts rows
 * carrying a field this central has no column for. Both are schema skew (§2.6), not activity —
 * and skew that shows up as healthy traffic is the exact failure the column comments in
 * server/central/centralMigrations.js exist to prevent.
 */
export function FleetOverviewPage() {
  const [range, setRange] = useState(FLEET_WINDOWS[1]);
  const { host } = useHost();
  const { data, loading, error, reload } = useFetch(
    () => fleet.summary({ hours: range.hours }),
    [range.hours],
  );
  const auto = useAutoRefresh({
    storageKey: "fleet-overview-auto-refresh",
    reload,
    dataSignal: data,
  });

  const outcomeBars = useMemo(
    () => list(data?.byOutcome).map((o) => ({ label: o.outcome, value: o.n })),
    [data],
  );
  const nodeBars = useMemo(
    () => list(data?.byNode).map((n) => ({ label: n.nodeId, value: n.n })),
    [data],
  );

  const totals = data?.totals;
  const denialRate = totals && totals.events > 0 ? totals.denied / totals.events : null;
  const avgLatency = num(totals?.avgLatencyMs);
  const stranded = host?.defaultPartitionRows ?? null;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Fleet overview</h1>
          <p>
            Every governed decision every node has shipped, over a window on{" "}
            <strong>central's own clock</strong> — what central <em>saw</em>, not what a node says
            happened. Native tool calls are not in these numbers and must not be added to them:
            they are observations rather than decisions, and they have{" "}
            <Link to="/fleet/native">their own page</Link>.
          </p>
        </div>
        <LiveControl auto={auto} onRefresh={reload}>
          <WindowPicker value={range} onChange={setRange} />
        </LiveControl>
      </div>

      {stranded !== null && stranded > 0 && (
        <div className="error-banner">
          {stranded.toLocaleString()} row{stranded === 1 ? "" : "s"} are sitting in
          central's default partition, which should be empty forever — partition maintenance has
          lapsed and needs an operator.
        </div>
      )}
      {error && <div className="error-banner">Could not load the fleet summary: {error}</div>}
      {loading && <div className="loading">Loading the fleet summary…</div>}

      {totals && (
        <>
          <div className="stat-grid">
            <StatTile
              label="Governed decisions"
              value={count(totals.events)}
              sub={`since ${when(data?.since)}`}
            />
            <StatTile
              label="Denial rate"
              value={pct(denialRate)}
              sub={`${count(totals.denied)} denied, ${count(totals.errored)} errored`}
            />
            <StatTile
              label="Nodes reporting"
              value={count(totals.nodes)}
              sub={`${count(totals.principals)} principals, ${count(totals.subjects)} people`}
            />
            <StatTile
              label="Capabilities exercised"
              value={count(totals.capabilities)}
              sub={`${count(totals.approved)} calls approved at the prompt`}
            />
            <StatTile
              label="Average latency"
              value={avgLatency === null ? "—" : `${avgLatency.toFixed(0)} ms`}
              sub="broker round trip, fleet-wide"
            />
            <StatTile
              label="Worst clock skew"
              value={totals.worstClockSkewMs === null ? "—" : `${Math.abs(totals.worstClockSkewMs).toLocaleString()} ms`}
              sub="largest gap between a node's clock and central's"
            />
          </div>

          {(totals.outcomeUnrecorded > 0 || totals.withUnknownFields > 0) && (
            <div className="card">
              <h2>Schema skew in this window</h2>
              <p className="muted">
                Not traffic. These count rows central could not read completely, which means some
                node in the fleet is running a build this central does not fully know — see §2.6.
                Left folded into the totals above they would read as ordinary healthy calls.
              </p>
              <div className="stat-grid">
                <StatTile
                  label="Events with no outcome recorded"
                  value={count(totals.outcomeUnrecorded)}
                  sub="shipped by a build that sends no outcome column"
                />
                <StatTile
                  label="Events carrying unknown fields"
                  value={count(totals.withUnknownFields)}
                  sub="kept verbatim in `extra` so nothing is lost"
                />
              </div>
            </div>
          )}

          <div className="dashboard-grid">
            <div className="card">
              <h2>By outcome</h2>
              <BarChart
                data={outcomeBars}
                color="var(--series-1)"
                emptyLabel="No events in this window."
              />
            </div>
            <div className="card">
              <h2>By node</h2>
              <BarChart
                data={nodeBars}
                color="var(--series-2)"
                emptyLabel="No node shipped anything in this window."
              />
            </div>
          </div>

          <div className="card">
            <h2>Denials by node</h2>
            {list(data?.byNode).length === 0 ? (
              <div className="empty-state">No node shipped anything in this window.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Events</th>
                    <th>Denied</th>
                    <th>Denial rate</th>
                  </tr>
                </thead>
                <tbody>
                  {list(data?.byNode).map((row) => (
                    <tr key={row.nodeId}>
                      <td>
                        <Link to={`/fleet/nodes/${encodeURIComponent(row.nodeId)}`}>
                          <code>{row.nodeId}</code>
                        </Link>
                      </td>
                      <td className="tabular">{count(row.n)}</td>
                      <td className="tabular">{count(row.denied)}</td>
                      <td className="muted tabular">{pct(row.n > 0 ? row.denied / row.n : null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
