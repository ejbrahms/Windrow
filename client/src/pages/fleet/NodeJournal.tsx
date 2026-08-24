import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { fleet } from "../../api/fleet";
import type { JournalEntry } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { StatTile } from "../../components/StatTile";
import { TierBadges, count, list, shortId, when } from "./shared";

/**
 * ONE NODE'S FAULT JOURNAL — what it decided while it could not reach central, and every denial an
 * enforcement pause let through. docs/design/disposable-nodes.md §3 calls this "the important one":
 * it used to exist in exactly one copy, on the machine, and a `docker rm` took it with the machine.
 * Now central holds it, so "what did that box actually do while it was off on its own" is a
 * question you can answer from here rather than by sshing into a container that no longer exists.
 *
 * FILTERING TO A SINGLE `pauseId` IS THE WHOLE POINT of the pause id, per §5 — it is what turns "a
 * pause happened" into "here is exactly what that pause suppressed". So the id is a filter you can
 * arrive on (from the enforcement page, one click) and set from any row (the Pause cell), and the
 * two counts stay whole-journal so you always see how much you are looking at against how much
 * there is.
 */

// A denial a pause let through is the alarming line on this page — it is the evidence §5 exists to
// surface — so its outcome reads red rather than the neutral tone an ordinary logged decision gets.
function outcomeTone(outcome: string | null, suppressed: boolean): string {
  if (suppressed) return "badge-denied";
  if (outcome === "denied") return "badge-denied";
  if (outcome === "errored" || outcome === "error") return "badge-error";
  if (outcome === "allowed" || outcome === "ok" || outcome === "allow") return "badge-ok";
  return "badge";
}

export function NodeJournalCard({
  nodeId,
  initialPauseId = null,
}: {
  nodeId: string;
  initialPauseId?: string | null;
}) {
  const [pauseId, setPauseId] = useState<string | null>(initialPauseId);
  const { data, loading, error, reload } = useFetch(
    () => fleet.journal(nodeId, { pauseId: pauseId ?? undefined, limit: 200 }),
    [nodeId, pauseId],
  );

  const entries = list<JournalEntry>(data?.entries);

  return (
    <div className="card">
      <h2>Fault journal</h2>
      <p className="muted">
        Every decision this node made without central, and — with a pause id on it — every denial an
        enforcement pause let through. The only record that a node stopped enforcing; §3 spent it on
        one copy on the machine, and this is the copy that survives a rebuild.
      </p>

      {data && (
        <div className="stat-grid">
          <StatTile
            label="Entries held"
            value={count(data.total)}
            sub={data.newest ? `newest ${when(data.newest)}` : "nothing recorded"}
          />
          <StatTile
            label="Let through by a pause"
            value={count(data.suppressed)}
            sub={
              data.suppressed === 0
                ? "no pause has suppressed a denial"
                : "denials a pause allowed and logged"
            }
          />
          <StatTile
            label="Oldest held"
            value={data.oldest ? when(data.oldest) : "—"}
            sub="how far back this journal reaches"
          />
        </div>
      )}

      {pauseId && (
        <div className="tabs" role="group" aria-label="Journal filter">
          <span className="muted" style={{ alignSelf: "center" }}>
            Showing only the window <code title={pauseId}>{shortId(pauseId)}</code>
          </span>
          <button type="button" className="btn" onClick={() => setPauseId(null)}>
            Clear filter
          </button>
        </div>
      )}

      {error && (
        <div className="error-banner">
          Could not load this node's journal: {error}{" "}
          <button type="button" className="btn" onClick={reload}>
            Retry
          </button>
        </div>
      )}
      {loading && <div className="loading">Reading this node's fault journal…</div>}

      {data && entries.length === 0 ? (
        <div className="empty-state">
          {pauseId
            ? "This pause suppressed nothing that reached central — no entry carries this window's id."
            : "This node has shipped no fault-journal entries. It has made no decision without central, and no pause has let anything through."}
        </div>
      ) : (
        data && (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Fault</th>
                <th>Tier</th>
                <th>Capability</th>
                <th>Principal</th>
                <th>Outcome</th>
                <th>Pause</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const suppressed = Boolean(e.pauseId);
                return (
                  <tr key={e.id}>
                    <td className="muted" title={e.receivedAt ?? undefined}>
                      {when(e.ts)}
                      {e.policyAgeMs !== null && e.policyAgeMs !== undefined && (
                        <div className="muted">policy {Math.round(e.policyAgeMs / 1000)}s old</div>
                      )}
                    </td>
                    <td>
                      {e.fault ?? "—"}
                      {(e.denialKind || e.why) && (
                        <div className="muted">{[e.denialKind, e.why].filter(Boolean).join(" · ")}</div>
                      )}
                    </td>
                    <td>{e.tier ? <TierBadges tiers={e.tier} /> : <span className="muted">—</span>}</td>
                    <td className="muted">
                      <code>{e.capability ?? "—"}</code>
                    </td>
                    <td className="muted">
                      <code title={e.principalId ?? undefined}>{e.principalId ?? "—"}</code>
                    </td>
                    <td>
                      {e.outcome ? (
                        <span className={`badge ${outcomeTone(e.outcome, suppressed)}`}>{e.outcome}</span>
                      ) : (
                        <span className="muted">not recorded</span>
                      )}
                    </td>
                    <td>
                      {e.pauseId ? (
                        // One click to narrow the whole journal to just what this window suppressed —
                        // the query §5 says the pause id exists to make answerable.
                        <button
                          type="button"
                          className="btn"
                          title={`Show only ${e.pauseId}`}
                          onClick={() => setPauseId(e.pauseId)}
                          disabled={pauseId === e.pauseId}
                        >
                          <code>{shortId(e.pauseId)}</code>
                        </button>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}

/**
 * The journal on its own page, deep-linkable with `?pauseId=` so the enforcement page can hand an
 * operator the exact window in one click. The card carries the rest — its own filter, its own
 * counts — so the page is just the route around it.
 */
export function FleetNodeJournalPage() {
  const { nodeId = "" } = useParams();
  const [search] = useSearchParams();
  const pauseId = search.get("pauseId");

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{nodeId}</h1>
          <p>
            This node's fault journal — what it decided without central, and what a pause let
            through. <Link to={`/fleet/nodes/${encodeURIComponent(nodeId)}`}>Back to this node</Link>{" "}
            · <Link to="/fleet/enforcement">Enforcement divergence</Link>.
          </p>
        </div>
      </div>
      <NodeJournalCard nodeId={nodeId} initialPauseId={pauseId} />
    </div>
  );
}
