import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fleet } from "../../api/fleet";
import type { FleetEvent } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { AssuranceBadge } from "../../components/Badge";
import { EventDrawer, ExpanderCell, useExpandedRows } from "../../components/EventDrawer";
import { LineChart } from "../../components/LineChart";
import { LatencyBreakdownChart } from "../../components/LatencyBreakdownChart";
import { LiveControl } from "../../components/LiveControl";
import { useAutoRefresh } from "../../hooks/useAutoRefresh";
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

/** The outcome values the dropdown offers. `unrecorded` is not an outcome the fleet ships — it is
 *  §2.6's sentinel for a row whose build had no outcome column, matched server-side as `IS NULL`, so
 *  narrowing to the unaccounted-for rows is a query rather than a scan of every page. */
const OUTCOME_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Any outcome" },
  { value: "ok", label: "OK" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
  { value: "error", label: "Error" },
  { value: "unrecorded", label: "Not recorded" },
];

/** The table's own time window, applied server-side on `observedAt` — central's arrival clock, the
 *  one the tail is already ordered by. Independent of the chart window above, and of the row cap:
 *  "the newest 100 denied calls in the last 24h" is a different request from "the last 24h, capped
 *  at 100". `0` hours means no window — the pure newest-`limit` tail. */
const HOUR_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Any time" },
  { value: 1, label: "Last hour" },
  { value: 24, label: "Last 24 hours" },
  { value: 168, label: "Last 7 days" },
  { value: 720, label: "Last 30 days" },
];

function actorOf(e: FleetEvent): string {
  return e.actorLoomId ?? e.actorAgentType ?? e.osUser ?? "—";
}

const rowKey = (e: FleetEvent) => `${e.nodeId}:${e.id}`;

export function FleetEventsPage() {
  // THE FILTER SET LIVES IN THE URL, not in component state — so a narrowed tail is a shareable
  // link ("?outcome=denied&principalId=…&text=…" gives the same rows back), a browser Back steps
  // through filter changes rather than dropping them, and a drill-down link from another page can
  // land here pre-filtered. `setFilter` drops a key when it is empty or at its default rather than
  // leaving "?outcome=&text=" litter in the bar.
  const [params, setParams] = useSearchParams();
  const nodeId = params.get("nodeId") ?? "";
  const limit = Number(params.get("limit")) || 100;
  const outcome = params.get("outcome") ?? "";
  const principalId = params.get("principalId") ?? "";
  const hours = Number(params.get("hours")) || 0;
  const text = params.get("text") ?? "";
  const setFilter = (key: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  // The text box is committed on submit rather than on every keystroke — each commit re-fetches, and
  // a per-keystroke query is a fetch storm. Seeded from the URL, and kept in sync when the URL text
  // changes from elsewhere (a Back, or a drill-down link).
  const [textInput, setTextInput] = useState(text);
  useEffect(() => setTextInput(text), [text]);

  const [onlyProblems, setOnlyProblems] = useState(false);
  const { isOpen, toggle } = useExpandedRows();
  // The window drives the two charts only; the table below is filtered by the `hours` control in the
  // filter bar. The node filter is shared between chart and table — narrowing to one node narrows
  // both.
  const [range, setRange] = useState(FLEET_WINDOWS[1]);
  const roster = useFetch(() => fleet.nodes(), []);
  const { data, loading, error, reload } = useFetch(
    () =>
      fleet.events({
        nodeId: nodeId || undefined,
        limit,
        outcome: outcome || undefined,
        principalId: principalId || undefined,
        hours: hours || undefined,
        text: text || undefined,
      }),
    [nodeId, limit, outcome, principalId, hours, text],
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

  // The events table is the primary live data; refresh it together with the two charts' series.
  const reloadAll = () => {
    reload();
    series.reload();
  };
  const auto = useAutoRefresh({
    storageKey: "fleet-events-auto-refresh",
    reload: reloadAll,
    dataSignal: data,
  });

  const events = useMemo(() => {
    const all = list(data?.events);
    if (!onlyProblems) return all;
    return all.filter((e) => e.outcome === "denied" || e.outcome === "error" || e.outcome === null);
  }, [data, onlyProblems]);

  // Whether any server-side filter is narrowing the tail — drives the empty-state wording, so "no
  // rows" reads as "your filters excluded everything" rather than the alarming "central holds none".
  const hasFilters = Boolean(nodeId || outcome || principalId || hours || text);

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
        <LiveControl auto={auto} onRefresh={reloadAll}>
          <WindowPicker value={range} onChange={setRange} label="Chart window" />
        </LiveControl>
      </div>

      <div className="filters">
        <label>
          Node
          <select value={nodeId} onChange={(e) => setFilter("nodeId", e.target.value)}>
            <option value="">Every node</option>
            {(roster.data?.nodes ?? []).map((n) => (
              <option key={n.nodeId} value={n.nodeId}>
                {n.hostname ?? n.nodeId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Outcome
          <select value={outcome} onChange={(e) => setFilter("outcome", e.target.value)}>
            {OUTCOME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Since
          <select
            value={hours}
            onChange={(e) => setFilter("hours", e.target.value === "0" ? "" : e.target.value)}
          >
            {HOUR_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Principal ID
          <input
            type="text"
            value={principalId}
            placeholder="exact principal id"
            onChange={(e) => setFilter("principalId", e.target.value)}
          />
        </label>
        {/* Text is committed on submit, not per keystroke — see the state note above. */}
        <form
          className="filter-search"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter("text", textInput.trim());
          }}
        >
          <label>
            Search
            <input
              type="search"
              value={textInput}
              placeholder="id, reason or name…"
              onChange={(e) => setTextInput(e.target.value)}
              onBlur={() => setFilter("text", textInput.trim())}
            />
          </label>
        </form>
        <label>
          Rows
          <select
            value={limit}
            onChange={(e) => setFilter("limit", e.target.value === "100" ? "" : e.target.value)}
          >
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
              : hasFilters
                ? "No events match these filters."
                : "Central holds no events yet."}
          </div>
        ) : (
          <table className="event-table">
            <thead>
              <tr>
                <th aria-label="Expand" />
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
              {events.map((e) => {
                const key = rowKey(e);
                const open = isOpen(key);
                return (
                <Fragment key={key}>
                <tr
                  className={"event-row" + (open ? " open" : "")}
                  onClick={() => toggle(key)}
                  aria-expanded={open}
                >
                  <ExpanderCell open={open} onToggle={() => toggle(key)} />
                  <td className="muted" title={e.ts ? `node said ${e.ts}` : undefined}>
                    {when(e.observedAt)}
                  </td>
                  <td>
                    <Link
                      to={`/fleet/nodes/${encodeURIComponent(e.nodeId)}`}
                      onClick={(ev) => ev.stopPropagation()}
                    >
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
                {open && <EventDrawer e={e} colSpan={11} />}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
