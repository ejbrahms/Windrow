import { useState } from "react";
import { Link } from "react-router-dom";
import { fleet } from "../../api/fleet";
import type { ShadowVerdict } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { BarChart } from "../../components/BarChart";
import { StatTile } from "../../components/StatTile";
import { FLEET_WINDOWS, WindowPicker, count, list, when } from "./shared";

/**
 * The panel phase 4's go/no-go is argued from — `GET /api/fleet/shadow` plus its history.
 *
 * FOUR VERDICTS, AND THE DISTINCTION BETWEEN THEM IS THE WHOLE VALUE. `lagging` is normal: the
 * shipper runs on a five-second timer and the node's own outbox explains the difference. `gap` is
 * the one that must stay at zero — central is missing shipments the node no longer has to give,
 * which is permanent loss in central's copy. `divergent` means the two ends hold a different
 * number of events for the same shipments, and nothing routine produces it.
 *
 * WHY `everyNodeAgrees` IS NOT DRAWN AS A GO SIGNAL. The route deliberately does not return a
 * boolean called `ready`, and this page keeps that distinction: shadow mode measures agreement,
 * and the decision to move authority also weighs how long the window is and how many nodes are in
 * it. So the tile says what was measured, and the reader decides.
 */

const VERDICT_TONE: Record<ShadowVerdict, string> = {
  match: "badge-ok",
  // Not a fault, and not drawn as one: the shipper is on a timer, so a node with a queue is a node
  // working normally. Toned as "approved" — it went through, with a qualification.
  lagging: "badge-approved",
  gap: "badge-denied",
  divergent: "badge-denied",
};

const VERDICT_LABEL: Record<ShadowVerdict, string> = {
  match: "Match",
  lagging: "Lagging",
  gap: "Gap",
  divergent: "Divergent",
};

const VERDICT_MEANING: Record<ShadowVerdict, string> = {
  match: "central holds exactly what the node holds, and the node's queue is empty",
  lagging: "central is behind, and the node's own outbox explains the difference — normal",
  gap: "central is missing shipments the node no longer has to give — permanent loss",
  divergent: "the two copies disagree about the same shipments — written by something else",
};

export function ShadowVerdictBadge({ verdict }: { verdict: ShadowVerdict }) {
  return (
    <span className={`badge ${VERDICT_TONE[verdict] ?? ""}`} title={VERDICT_MEANING[verdict]}>
      {VERDICT_LABEL[verdict] ?? verdict}
    </span>
  );
}

export function FleetShadowPage() {
  const [range, setRange] = useState(FLEET_WINDOWS[2]);
  const status = useFetch(() => fleet.shadow({ hours: range.hours }), [range.hours]);
  const history = useFetch(() => fleet.shadowHistory({ limit: 100 }), []);

  const data = status.data;
  const latest = list(data?.latest);
  const gaps = latest.filter((r) => r.verdict === "gap").length;
  const divergent = latest.filter((r) => r.verdict === "divergent").length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Shadow reconciliation</h1>
          <p>
            How often central's copy of each node's usage matched the node's own, and how far
            behind it ran when it did not. The node reports its own account and central compares —
            central never reaches into a node to check up on it.
          </p>
        </div>
        <div className="live-control">
          <WindowPicker value={range} onChange={setRange} label="Tally window" />
        </div>
      </div>

      {status.error && <div className="error-banner">Could not load shadow status: {status.error}</div>}
      {status.loading && <div className="loading">Loading reconciliation status…</div>}

      {data && (
        <>
          <div className="stat-grid">
            <StatTile
              label="Nodes compared"
              value={count(latest.length)}
              sub={
                data.everyNodeAgrees
                  ? "every latest verdict is match or lagging"
                  : "at least one node's latest verdict is a gap or a divergence"
              }
            />
            <StatTile
              label="Nodes with a gap"
              value={count(gaps)}
              sub="must be zero before authority moves"
            />
            <StatTile
              label="Nodes diverging"
              value={count(divergent)}
              sub="a copy written by something other than this pipeline"
            />
          </div>

          <div className="card">
            <h2>Verdicts in this window</h2>
            <BarChart
              data={list(data.tally).map((t) => ({ label: VERDICT_LABEL[t.verdict] ?? t.verdict, value: t.n }))}
              color="var(--series-1)"
              emptyLabel="No comparison has been run in this window."
            />
            <p className="muted">
              Since {when(data.since)}. A run of <strong>match</strong> and{" "}
              <strong>lagging</strong> is what a healthy fleet looks like; the shipper's timer makes
              lagging the common case rather than the exception.
            </p>
          </div>

          <div className="card">
            <h2>Latest verdict per node</h2>
            {latest.length === 0 ? (
              <div className="empty-state">
                No node has ever been compared. A comparison is produced by{" "}
                <code>scripts/shadow-compare.js</code> and posted to{" "}
                <code>/api/ingest/reconcile</code>.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Verdict</th>
                    <th>Checked</th>
                    <th>Node held</th>
                    <th>Central held</th>
                    <th>Outbox</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {latest.map((row) => (
                    <tr key={row.nodeId}>
                      <td>
                        <Link to={`/fleet/nodes/${encodeURIComponent(row.nodeId)}`}>
                          <code>{row.nodeId}</code>
                        </Link>
                      </td>
                      <td>
                        <ShadowVerdictBadge verdict={row.verdict} />
                      </td>
                      <td className="muted">{when(row.checkedAt)}</td>
                      <td className="tabular">{count(row.nodeEventCount)}</td>
                      <td className="tabular">{count(row.centralEventCount)}</td>
                      <td className="tabular">{count(row.nodeOutboxPending)}</td>
                      <td className="muted">{row.detail ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      <div className="card">
        <h2>Every comparison, newest first</h2>
        {history.error && <div className="error-banner">Could not load history: {history.error}</div>}
        {history.data && list(history.data.checks).length === 0 ? (
          <div className="empty-state">No comparison has been recorded yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Checked</th>
                <th>Node</th>
                <th>Verdict</th>
                <th>Node seq</th>
                <th>Central seq</th>
                <th>Chain heads agree</th>
              </tr>
            </thead>
            <tbody>
              {list(history.data?.checks).map((c) => (
                <tr key={c.id}>
                  <td className="muted">{when(c.checkedAt)}</td>
                  <td>
                    <Link to={`/fleet/nodes/${encodeURIComponent(c.nodeId)}`}>
                      <code>{c.nodeId}</code>
                    </Link>
                  </td>
                  <td>
                    <ShadowVerdictBadge verdict={c.verdict} />
                  </td>
                  <td className="tabular">{count(c.nodeChainSeq)}</td>
                  <td className="tabular">{count(c.centralMaxSeq)}</td>
                  <td>
                    {c.nodeChainHash === null || c.centralChainHash === null ? (
                      <span className="muted">not recorded</span>
                    ) : c.nodeChainHash === c.centralChainHash ? (
                      <span className="badge badge-ok">Same head</span>
                    ) : (
                      <span className="badge badge-denied">Different head</span>
                    )}
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
