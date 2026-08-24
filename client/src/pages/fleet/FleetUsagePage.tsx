import { useMemo, useState } from "react";
import { fleet, num } from "../../api/fleet";
import { FLEET_USAGE_DIMENSIONS } from "../../api/fleet";
import type { FleetUsageDimension } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { BarChart } from "../../components/BarChart";
import { FLEET_WINDOWS, WindowPicker, count, list, pct, when } from "./shared";

/**
 * Fleet usage grouped by whichever dimension you ask for — `GET /api/fleet/usage?by=`.
 *
 * ONE PAGE RATHER THAN ELEVEN, because the server offers this as one query with an allow-list and
 * the allow-list is Part 1's identity model made explicit: `subjectId` is the person,
 * `principalId` is the registry row, and the four `actor*` columns are the agent as a *dimension
 * of the call*, snapshotted at call time rather than looked up through a mutable principal row.
 * Offering exactly this set is what makes "usage by human" and "usage by backend" the same
 * question asked twice instead of two hand-written pages that drift apart.
 *
 * THE SNAPSHOT COLUMNS ARE THE HONEST ONES FOR HISTORY. Joining `principalId` to a principal row
 * would rewrite what the past looked like every time somebody's identity got back-filled or an
 * instance was repointed; `actorLoomId` and its siblings are what the hook observed when the call
 * was made, and they never move.
 */

const DIMENSION_LABEL: Record<FleetUsageDimension, string> = {
  subjectId: "Person (subject)",
  principalId: "Principal",
  capabilityId: "Capability",
  nodeId: "Node",
  outcome: "Outcome",
  actorAgentType: "Agent type",
  actorBackend: "Backend",
  actorField: "Workspace",
  actorLoomId: "Loom",
  hostname: "Host",
  osUser: "OS user",
};

// Which of the eleven answer a question about a *person* rather than about a machine or a piece of
// software. Grouped in the picker rather than listed flat, because "usage by human" and "usage by
// backend" being one control is only useful if the control says which one you are looking at.
const PEOPLE: FleetUsageDimension[] = ["subjectId", "principalId", "osUser"];
const AGENTS: FleetUsageDimension[] = ["actorLoomId", "actorAgentType", "actorBackend", "actorField"];

export function FleetUsagePage() {
  const [range, setRange] = useState(FLEET_WINDOWS[1]);
  const [by, setBy] = useState<FleetUsageDimension>("subjectId");
  const { data, loading, error } = useFetch(
    () => fleet.usage({ by, hours: range.hours, limit: 50 }),
    [by, range.hours],
  );

  const rows = useMemo(() => list(data?.rows), [data]);
  // The bar's label is the NAME where one resolved and the id otherwise — a chart axis is the one
  // place an id is pure noise, since nothing can be copied out of it anyway.
  const bars = useMemo(
    () => rows.slice(0, 15).map((r) => ({ label: r.label ?? r.key, value: r.calls })),
    [rows],
  );
  const totalCalls = rows.reduce((a, r) => a + r.calls, 0);
  const totalDenied = rows.reduce((a, r) => a + r.denied, 0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Fleet usage</h1>
          <p>
            Governed decisions across every node, grouped however you need them. The window is on
            central's own clock, and a key of <code>(unrecorded)</code> means the column was never
            filled in for those calls — not that it was empty.
          </p>
        </div>
        <div className="live-control">
          <WindowPicker value={range} onChange={setRange} />
        </div>
      </div>

      <div className="filters">
        <label>
          Group by
          <select value={by} onChange={(e) => setBy(e.target.value as FleetUsageDimension)}>
            <optgroup label="People">
              {PEOPLE.map((d) => (
                <option key={d} value={d}>
                  {DIMENSION_LABEL[d]}
                </option>
              ))}
            </optgroup>
            <optgroup label="Agents">
              {AGENTS.map((d) => (
                <option key={d} value={d}>
                  {DIMENSION_LABEL[d]}
                </option>
              ))}
            </optgroup>
            <optgroup label="What and where">
              {FLEET_USAGE_DIMENSIONS.filter((d) => !PEOPLE.includes(d) && !AGENTS.includes(d)).map((d) => (
                <option key={d} value={d}>
                  {DIMENSION_LABEL[d]}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
      </div>

      {error && <div className="error-banner">Could not load fleet usage: {error}</div>}
      {loading && <div className="loading">Grouping fleet usage…</div>}

      <div className="card">
        <h2>Top {DIMENSION_LABEL[by].toLowerCase()}</h2>
        <BarChart data={bars} color="var(--series-1)" emptyLabel="No calls in this window." />
      </div>

      <div className="card">
        <h2>
          {rows.length} row{rows.length === 1 ? "" : "s"}
          {rows.length > 0 && (
            <span className="muted">
              {" "}
              — {count(totalCalls)} calls, {count(totalDenied)} denied
            </span>
          )}
        </h2>
        {rows.length === 0 ? (
          <div className="empty-state">No node shipped a governed call in this window.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{DIMENSION_LABEL[by]}</th>
                <th>Calls</th>
                <th>Denied</th>
                <th>Denial rate</th>
                <th>Avg latency</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const avg = num(row.avgLatencyMs);
                return (
                  <tr key={row.key}>
                    <td>
                      {/*
                        NAME FIRST, ID UNDERNEATH — never one instead of the other. The name is what
                        makes the row legible; the id is what makes it actionable, and a table that
                        showed only a name would be unusable for looking anything up. Where nothing
                        resolved, the id stands alone rather than being padded with a placeholder.
                      */}
                      {row.label ? (
                        <>
                          <div>{row.label}</div>
                          <code className="muted">{row.key}</code>
                        </>
                      ) : (
                        <code>{row.key}</code>
                      )}
                    </td>
                    <td className="tabular">{count(row.calls)}</td>
                    <td className="tabular">{count(row.denied)}</td>
                    <td className="muted tabular">{pct(row.calls > 0 ? row.denied / row.calls : null)}</td>
                    <td className="muted tabular">{avg === null ? "—" : `${avg.toFixed(0)} ms`}</td>
                    <td className="muted">{when(row.lastSeenAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
