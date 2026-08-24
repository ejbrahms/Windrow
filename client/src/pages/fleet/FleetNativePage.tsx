import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fleet } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { BarChart } from "../../components/BarChart";
import { NativeCallsChart } from "../../components/NativeCallsChart";
import { StatTile } from "../../components/StatTile";
import { FLEET_WINDOWS, WindowPicker, count, list, pct, when } from "./shared";

/**
 * What the fleet's agents actually DID, as against what they were governed for —
 * `GET /api/fleet/native`, the read side of docs/design/dashboard-placement.md item 1.
 *
 * NOTHING ON THIS PAGE MAY BE ADDED TO ANYTHING ON THE OVERVIEW, and the wording is built to make
 * that hard to do by accident. The server's shape already refuses to help: no key here is called
 * `calls` or `events`, only `observations`, because a native observation is a *sighting* and a
 * usage event is a *decision*. Native calls outnumber governed ones by one to two orders of
 * magnitude, so a page that summed them would silently change the meaning of every drift number,
 * usage summary and denial rate in the app.
 *
 * `denied` HERE IS NOT A GOVERNANCE VERDICT. It means the harness itself refused the tool — a
 * permission rule in a settings file, not a grant check. Nothing on this page was ever allowed or
 * refused on governance grounds; these calls were always going to run.
 *
 * AN EMPTY WINDOW MEANS NOTHING WAS OBSERVED, not that nothing happened. Observations arrive off a
 * best-effort spool that may drop rows under load, and a node that has never shipped them shows
 * up as absent rather than as quiet — which is why the by-node table names the last time each was
 * heard from rather than only its count.
 */
export function FleetNativePage() {
  const [range, setRange] = useState(FLEET_WINDOWS[1]);
  const [nodeId, setNodeId] = useState("");
  const roster = useFetch(() => fleet.nodes(), []);
  const { data, loading, error } = useFetch(
    () => fleet.native({ hours: range.hours, nodeId: nodeId || undefined, limit: 20 }),
    [range.hours, nodeId],
  );

  // CALLS OVER TIME, restored — see the comment above the chart below for what happened to it.
  //
  // The granularity follows the WINDOW rather than being a second control, which is the choice
  // NativeCallsPage already made for this chart on the node: a one-hour window wants minutes and a
  // month wants hours, and offering both knobs lets someone ask for 43,200 one-minute buckets. The
  // server caps that at 400 regardless, but a control that can request a truncated answer is a
  // control that quietly lies about the window it is labelled with.
  const series = useFetch(
    () =>
      fleet.nativeSeries({
        granularity: range.hours <= 1 ? "minute" : "hour",
        windowMinutes: range.hours * 60,
        nodeId: nodeId || undefined,
      }),
    [range.hours, nodeId],
  );

  const toolBars = useMemo(
    () => list(data?.byTool).map((t) => ({ label: t.toolName, value: t.observations })),
    [data],
  );
  const principalBars = useMemo(
    () =>
      list(data?.byPrincipal).map((p) => ({
        label: p.name ?? p.principalId,
        value: p.observations,
      })),
    [data],
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Native tool observations</h1>
          <p>
            Read, Edit, Write, Bash, Grep and friends, observed across every node that ships them.
            These carry no capability and were never grant-checked — they are sightings, not
            decisions, and they must never be added to the{" "}
            <Link to="/fleet/usage">governed totals</Link>.
          </p>
        </div>
        <div className="live-control">
          <WindowPicker value={range} onChange={setRange} />
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
      </div>

      {error && <div className="error-banner">Could not load native observations: {error}</div>}
      {loading && <div className="loading">Loading native observations…</div>}

      {data && (
        <>
          <div className="stat-grid">
            <StatTile
              label="Observations"
              value={count(data.observations)}
              sub={`since ${when(data.since)}`}
            />
            <StatTile
              label="Nodes observed"
              value={count(data.nodes)}
              sub={`${count(data.principals)} principals seen working`}
            />
            <StatTile
              label="Tool errors"
              value={count(data.errors)}
              sub={pct(data.observations > 0 ? data.errors / data.observations : null) + " of observations"}
            />
            <StatTile
              label="Refused by the harness"
              value={count(data.denied)}
              sub="a permission rule stopped the tool — not a grant check"
            />
          </div>

          {/*
            CALLS OVER TIME — the same chart the node used to draw for itself, in a fleet scope.
            `NativeCallsChart` is reused unchanged: central's /api/fleet/native/series returns the
            identical bucket shape the node's /api/native-calls/timeseries always has, precisely so
            there is one chart here and not two that disagree.

            IT IS ABOVE THE BAR CHARTS BECAUSE IT ANSWERS A DIFFERENT KIND OF QUESTION. The bars say
            what was used; this says WHEN, and on an observability page that is the one that catches
            the failure the page exists to catch — a node that stopped shipping shows up as a series
            falling to zero and staying there, which no total or ranking can show you. Zero-filled
            for the same reason: a gap drawn as a straight line between two busy hours would hide
            exactly that.
          */}
          <div className="card">
            <h2>Observations over time</h2>
            {series.error && (
              <div className="error-banner">Could not load the series: {series.error}</div>
            )}
            {series.loading && !series.data && <div className="loading">Loading…</div>}
            {series.data && (
              <NativeCallsChart
                data={series.data.byBucket}
                granularity={series.data.granularity}
                clockNote="Bucketed on when central received each observation, not the node's own clock — so a node draining a backlog appears as a spike."
              />
            )}
          </div>

          <div className="dashboard-grid">
            <div className="card">
              <h2>By tool</h2>
              <BarChart data={toolBars} color="var(--series-1)" emptyLabel="Nothing observed in this window." />
            </div>
            <div className="card">
              <h2>Who has been busy</h2>
              <BarChart
                data={principalBars}
                color="var(--series-2)"
                emptyLabel="Nothing observed in this window."
              />
            </div>
          </div>

          <div className="card">
            <h2>Tools, with what went wrong</h2>
            {list(data.byTool).length === 0 ? (
              <div className="empty-state">
                Nothing observed in this window. Observations arrive off a best-effort spool — an
                empty window means nothing was <em>observed</em>, not that nothing happened.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Observations</th>
                    <th>Errors</th>
                    <th>Refused</th>
                    <th>Error rate</th>
                  </tr>
                </thead>
                <tbody>
                  {list(data.byTool).map((t) => (
                    <tr key={t.toolName}>
                      <td>
                        <code>{t.toolName}</code>
                      </td>
                      <td className="tabular">{count(t.observations)}</td>
                      <td className="tabular">{count(t.errors)}</td>
                      <td className="tabular">{count(t.denied)}</td>
                      <td className="muted tabular">
                        {pct(t.observations > 0 ? t.errors / t.observations : null)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <h2>By node</h2>
            {list(data.byNode).length === 0 ? (
              <div className="empty-state">No node shipped an observation in this window.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Observations</th>
                    <th>Last observed</th>
                  </tr>
                </thead>
                <tbody>
                  {list(data.byNode).map((n) => (
                    <tr key={n.nodeId}>
                      <td>
                        <Link to={`/fleet/nodes/${encodeURIComponent(n.nodeId)}`}>
                          <code>{n.nodeId}</code>
                        </Link>
                      </td>
                      <td className="tabular">{count(n.observations)}</td>
                      <td className="muted">{when(n.lastObservedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted">
              Central saw observations from {when(data.observedFrom)} to {when(data.observedTo)} in
              this window. A node absent from this table has never shipped native observations —
              which is different from having been quiet.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
