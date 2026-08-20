import { useMemo, useState } from "react";
import { useFetch } from "../api/useFetch";
import { nativeCalls } from "../api/nativeCalls";
import type { NativeToolEvent, NativeToolOutcome } from "../api/nativeCalls";

// Native harness tools (Read, Edit, Write, Bash, Grep, Glob, …) were invisible to this system
// until now: the hook maps a tool name to a registered capability, a native tool has none, so no
// usage event was ever written. This card is the first view of them — and it is *observability
// only*. Nothing here was allowed or refused on governance grounds; these calls always run.
//
// The whole design of the card is about not letting that be misread:
//   - the header says "observed, not governed" and the note under it says why, because a table of
//     tool calls sitting on the governance dashboard otherwise reads as a table of decisions;
//   - the outcome column is labelled "Ran" / "Failed" / "Blocked by harness", never "Allowed" —
//     which is why it doesn't reuse OutcomeBadge, whose vocabulary ("Allowed", "Approved (ask)")
//     is the broker's and would assert a grant check that never happened. It does reuse the
//     badge *classes* so the colours stay consistent with the rest of the dashboard;
//   - the observation window is stated even when the card is empty, since these arrive late off a
//     best-effort spool drain and can be dropped under load — "nothing observed" is a much
//     weaker claim than "nothing happened", and an empty window is a third thing again.

const WINDOW_MINUTES = 1440;
const RECENT_LIMIT = 50;
const TOP_TOOLS = 8;

// Labels for the three states, worded as what the *harness* did rather than what a grant said.
const OUTCOME_LABEL: Record<NativeToolOutcome, string> = {
  ok: "Ran",
  error: "Failed",
  denied: "Blocked by harness",
};

/** Relative time, because for a live feed "3m ago" answers the only question anyone has of the
 * column; the exact timestamp is on the row's title attribute for when it doesn't. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** The most useful single identifier for who made the call. The actor fields are snapshots taken
 * when the observation was recorded, so they survive a principal being renamed or repointed;
 * the principal name (resolved from the summary) is the friendlier label when we have it.
 *
 * `actorHumanName` sits between the two because the summary only covers the *window* — a recent
 * list filtered to a tool nobody else used can hold a principal the summary never mentioned, and
 * the event's own recorded name is a better answer there than a raw loom id. Falling through to
 * the loom id remains correct rather than merely tolerable: rows predating that column genuinely
 * never had a name recorded, and showing the id is honest where guessing one would not be. */
function actorLabel(e: NativeToolEvent, principalNameById: Map<string, string>): string {
  return principalNameById.get(e.principalId) ?? e.actorHumanName ?? e.actorLoomId ?? e.principalId;
}

export function NativeCallsCard() {
  const { data: summary, loading: loadingSummary, error: summaryError } = useFetch(
    () => nativeCalls.summary({ windowMinutes: WINDOW_MINUTES }),
    [],
  );
  const { data: events, loading: loadingEvents, error: eventsError } = useFetch(
    () => nativeCalls.list({ limit: RECENT_LIMIT }),
    [],
  );

  // The recent list is long and mostly Read/Bash noise; a tool filter is the one control that
  // makes "what did this agent actually touch" answerable without paging.
  const [tool, setTool] = useState("");

  // byPrincipal is the only place the API hands back a principal *name*, so it doubles as the
  // lookup table for the recent list rather than making the card fetch /principals as well.
  const principalNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of summary?.byPrincipal ?? []) map.set(p.principalId, p.name);
    return map;
  }, [summary]);

  const topTools = useMemo(() => (summary?.byTool ?? []).slice(0, TOP_TOOLS), [summary]);

  const filtered = useMemo(
    () => (events ?? []).filter((e) => !tool || e.toolName === tool),
    [events, tool],
  );

  const error = summaryError ?? eventsError;
  const loading = loadingSummary || loadingEvents;

  // A fresh install has zero rows and that is entirely normal, so it gets an explanatory empty
  // state rather than anything that looks like a failure. `observedFrom === null` with total 0 is
  // "nothing has ever been observed"; a window with a total of 0 would mean retention aged it out.
  const nothingObserved = summary !== null && summary.total === 0;

  return (
    <div className="card">
      <h2>
        Native tool calls <span className="muted">observed, not governed</span>
      </h2>

      <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
        Harness tools (Read, Edit, Write, Bash, …) carry no capability, so none of these went
        through a grant check — they are recorded for visibility only and were always allowed.
        Collection is best-effort and batched, so counts here are a floor, not an audit.
      </p>

      {error && <div className="error-banner">Could not load native tool calls: {error}</div>}
      {loading && !summary && <div className="loading">Loading native tool calls…</div>}

      {summary && (
        <>
          <div className="stat-grid">
            <div className="stat-tile">
              <div className="label">Observed calls</div>
              <div className="value">{summary.total}</div>
              <div className="sub">last {Math.round(WINDOW_MINUTES / 60)}h</div>
            </div>
            <div className="stat-tile">
              <div className="label">Errors</div>
              <div className="value">{summary.errors}</div>
              <div className="sub">the tool itself failed</div>
            </div>
            <div className="stat-tile">
              <div className="label">Blocked by harness</div>
              <div className="value">{summary.denied}</div>
              <div className="sub">a permission rule, not a grant</div>
            </div>
            <div className="stat-tile">
              <div className="label">Observation window</div>
              {/* Stated even when empty: it is what separates "nothing has been observed" from
                  "everything in range has aged out of retention". */}
              <div className="value" style={{ fontSize: 14 }}>
                {summary.observedFrom && summary.observedTo
                  ? `${new Date(summary.observedFrom).toLocaleString()} → ${new Date(
                      summary.observedTo,
                    ).toLocaleString()}`
                  : "No observations retained"}
              </div>
            </div>
          </div>

          {nothingObserved ? (
            <div className="empty-state">
              No native tool calls observed yet. On a new install this is normal — observations
              only start once the harness hooks have run.
            </div>
          ) : (
            <div className="dashboard-grid">
              <div>
                <h3 style={{ fontSize: 12, margin: "0 0 8px" }}>
                  Top tools <span className="muted">({summary.byTool.length} seen)</span>
                </h3>
                {topTools.length === 0 ? (
                  <div className="empty-state">No tools in this window.</div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Tool</th>
                        <th>Calls</th>
                        <th>Errors</th>
                        <th>Blocked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topTools.map((t) => (
                        <tr key={t.toolName}>
                          <td>
                            {/* Doubles as the filter for the recent list — clicking a tool is the
                                natural next question after seeing its count. */}
                            <button
                              type="button"
                              className={"tab" + (tool === t.toolName ? " active" : "")}
                              onClick={() => setTool(tool === t.toolName ? "" : t.toolName)}
                            >
                              {t.toolName}
                            </button>
                          </td>
                          <td>{t.count}</td>
                          <td>{t.errors > 0 ? t.errors : <span className="muted">—</span>}</td>
                          <td>{t.denied > 0 ? t.denied : <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div>
                <h3 style={{ fontSize: 12, margin: "0 0 8px" }}>
                  Recent{" "}
                  <span className="muted">
                    {tool ? `${tool} only` : `newest ${RECENT_LIMIT}`}
                  </span>
                </h3>
                {filtered.length === 0 ? (
                  <div className="empty-state">
                    {tool ? `No recent ${tool} calls.` : "No recent native tool calls."}
                  </div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Tool</th>
                        <th>Detail</th>
                        <th>Actor</th>
                        <th>Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((e) => (
                        <tr key={e.id}>
                          <td className="muted" title={new Date(e.ts).toLocaleString()}>
                            {relativeTime(e.ts)}
                          </td>
                          <td>{e.toolName}</td>
                          {/* For Bash this is only the program name; for the file tools it is a
                              path, which can be long, so the full value goes on the title. */}
                          <td className="muted" title={e.detail ?? undefined}>
                            {e.detail ?? "—"}
                          </td>
                          <td title={e.actorLoomId ?? undefined}>
                            {actorLabel(e, principalNameById)}
                          </td>
                          <td>
                            {/* Badge classes only — the wording is the harness's, not the
                                broker's. See the note at the top of this file. */}
                            <span className={`badge badge-${e.outcome}`} title={e.reason ?? undefined}>
                              {OUTCOME_LABEL[e.outcome]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
