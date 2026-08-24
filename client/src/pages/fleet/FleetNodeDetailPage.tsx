import { Link, useParams } from "react-router-dom";
import { fleet } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { StatTile } from "../../components/StatTile";
import { count, list, shortId, when } from "./shared";
import { ShadowVerdictBadge } from "./FleetShadowPage";
import { NodeJournalCard } from "./NodeJournal";

/**
 * One node's stream, and whether central's copy of it can be believed.
 *
 * TWO QUESTIONS THAT LOOK LIKE ONE. `/stream` asks whether central RECEIVED everything the node
 * sent — holes in the shipment ledger, located rather than merely counted, because an operator
 * asked to explain a gap needs to know which shipments went missing and roughly when. `/verify`
 * asks whether what central received still LINKS — each row's `prevHash` against the previous
 * row's `hash`, and the sequence dense. A shipment that never arrived marks both, which is why
 * they are shown one above the other rather than merged into a single verdict.
 *
 * BOTH ARE PER INCARNATION, and that is the fix item 5 landed rather than a display nicety. A
 * rebuilt node starts again at seq 1 with a null prevHash. Walked as one sequence that is
 * indistinguishable from a spliced log — and it would happen on every single rebuild, so the
 * detector would spend its life reporting tampering that never occurred. An alarm that always
 * rings gets switched off, and then the real one is missed too. Density was always a claim about
 * one writer's output, and a writer is a lifetime rather than a machine.
 */
export function FleetNodeDetailPage() {
  const { nodeId = "" } = useParams();
  const stream = useFetch(() => fleet.nodeStream(nodeId), [nodeId]);
  const verify = useFetch(() => fleet.nodeVerify(nodeId), [nodeId]);
  const events = useFetch(() => fleet.events({ nodeId, limit: 50 }), [nodeId]);
  const history = useFetch(() => fleet.shadowHistory({ nodeId, limit: 20 }), [nodeId]);

  const s = stream.data;
  const v = verify.data;
  const gaps = list(s?.gaps);
  const breaks = list(v?.breaks);
  const heads = list(v?.heads);
  const missing = gaps.reduce((a, g) => a + g.missing, 0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{nodeId}</h1>
          <p>
            What central holds for this node's stream, including the holes, and whether the hash
            chain in what arrived still links. <Link to="/fleet/nodes">Back to the roster</Link> ·{" "}
            <Link to="/fleet/enforcement">Enforcement divergence</Link>.
          </p>
        </div>
      </div>

      {(stream.error || verify.error) && (
        <div className="error-banner">Could not load this node: {stream.error ?? verify.error}</div>
      )}
      {(stream.loading || verify.loading) && <div className="loading">Reading this node's stream…</div>}

      {s && (
        <div className="stat-grid">
          <StatTile
            label="Shipments received"
            value={count(s.shipments)}
            sub={s.lastReceivedAt ? `last ${when(s.lastReceivedAt)}` : "nothing has arrived"}
          />
          <StatTile
            label="Events held"
            value={count(s.events)}
            sub={`highest chain seq ${count(s.maxChainSeq)}`}
          />
          <StatTile
            label="Missing shipments"
            value={count(missing)}
            sub={
              missing === 0
                ? "central's copy is dense within every lifetime"
                : `${gaps.length} hole${gaps.length === 1 ? "" : "s"} — audit central will never receive`
            }
          />
          <StatTile
            label="Incarnations"
            value={count(s.incarnations)}
            sub="lifetimes of this machine that have shipped"
          />
        </div>
      )}

      <div className="card">
        <h2>Chain verification</h2>
        {v && (
          <p className="muted">
            {v.ok ? (
              <>
                {count(v.checked)} events checked
                {/* A central predating item 5 reports no incarnation count at all, and
                    "checked across — incarnations" is worse than not mentioning them. */}
                {typeof v.incarnations === "number" && (
                  <>
                    {" "}
                    across {v.incarnations} incarnation{v.incarnations === 1 ? "" : "s"}
                  </>
                )}{" "}
                — every row's <code>prevHash</code> matches the row before it, and each lifetime's
                sequence is dense. Central does not recompute the hashes; it checks linkage, which
                is what detects a row removed, reordered or inserted in the copy it holds.
              </>
            ) : (
              <>
                {count(v.breakCount)} break{v.breakCount === 1 ? "" : "s"} in {count(v.checked)}{" "}
                events. Nothing routine produces this within a single incarnation.
              </>
            )}
          </p>
        )}
        {v && breaks.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Incarnation</th>
                <th>At seq</th>
                <th>Kind</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {breaks.map((b) => (
                <tr key={`${b.incarnation}:${b.at}:${b.kind}`}>
                  <td title={b.incarnation}>
                    <code>{shortId(b.incarnation)}</code>
                  </td>
                  <td className="tabular">{b.at}</td>
                  <td>
                    <span className="badge badge-denied">{b.kind === "missing" ? "Hole" : "Unlinked"}</span>
                  </td>
                  <td className="muted">{b.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {v && heads.length > 0 && (
          <>
            <h3 className="section-heading">Chain head per lifetime</h3>
            <table>
              <thead>
                <tr>
                  <th>Incarnation</th>
                  <th>Tip seq</th>
                  <th>Hash</th>
                </tr>
              </thead>
              <tbody>
                {heads.map((h) => (
                  <tr key={h.incarnation}>
                    <td title={h.incarnation}>
                      <code>{shortId(h.incarnation)}</code>
                    </td>
                    <td className="tabular">{h.seq}</td>
                    <td className="muted">
                      <code>{shortId(h.hash, 16)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {v && v.checked === 0 && (
          <div className="empty-state">This node has shipped no chained events yet.</div>
        )}
      </div>

      <div className="card">
        <h2>Gaps in the shipment ledger</h2>
        {gaps.length === 0 ? (
          <div className="empty-state">
            No holes. Every shipment this node sent, within every lifetime, arrived.
          </div>
        ) : (
          <>
            <p className="muted">
              Located rather than counted: the size of the loss says nothing about which shipments
              went missing, and an operator asked to explain a gap needs the log around that
              moment.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Incarnation</th>
                  <th>From seq</th>
                  <th>To seq</th>
                  <th>Missing</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((g) => (
                  <tr key={`${g.incarnation}:${g.from}`}>
                    <td title={g.incarnation ?? undefined}>
                      <code>{shortId(g.incarnation)}</code>
                    </td>
                    <td className="tabular">{g.from}</td>
                    <td className="tabular">{g.to}</td>
                    <td className="tabular">{count(g.missing)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="card">
        <h2>Reconciliation history</h2>
        {history.error && <div className="error-banner">Could not load history: {history.error}</div>}
        {history.data && list(history.data.checks).length === 0 ? (
          <div className="empty-state">
            This node has never been compared against its own account of itself. A comparison is
            produced by <code>scripts/shadow-compare.js</code>, not by central going and asking.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Checked</th>
                <th>Verdict</th>
                <th>Node held</th>
                <th>Central held</th>
                <th>Outbox</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {list(history.data?.checks).map((c) => (
                <tr key={c.id}>
                  <td className="muted">{when(c.checkedAt)}</td>
                  <td>
                    <ShadowVerdictBadge verdict={c.verdict} />
                  </td>
                  <td className="tabular">{count(c.nodeEventCount)}</td>
                  <td className="tabular">{count(c.centralEventCount)}</td>
                  <td className="tabular">{count(c.nodeOutboxPending)}</td>
                  <td className="muted">{c.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Most recent events from this node</h2>
        {events.error && <div className="error-banner">Could not load events: {events.error}</div>}
        {events.data && list(events.data.events).length === 0 ? (
          <div className="empty-state">Central holds no events for this node.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Observed</th>
                <th>Seq</th>
                <th>Principal</th>
                <th>Capability</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {list(events.data?.events).map((e) => (
                <tr key={e.id}>
                  <td className="muted">{when(e.observedAt)}</td>
                  <td className="tabular" title={e.incarnation ?? undefined}>
                    {count(e.seq)}
                  </td>
                  {/*
                    Name where central can resolve it, id where it cannot — the same rule as the
                    fleet Events page, and it has to BE the same rule: two tables of the same rows
                    that disagree about how to name them is worse than either choice on its own.
                    The id stays in the tooltip, because a node-detail table is where somebody is
                    already investigating one machine and needs the exact value to carry onward.
                  */}
                  <td className="muted">
                    <code title={e.principalId ?? undefined}>
                      {e.principalLabel ?? e.principalId ?? "—"}
                    </code>
                  </td>
                  <td className="muted">
                    <code title={e.capabilityId ?? undefined}>
                      {e.capabilityLabel ?? e.capabilityId ?? "—"}
                    </code>
                  </td>
                  <td>
                    {e.outcome ? (
                      <span className={`badge badge-${e.outcome}`}>{e.outcome}</span>
                    ) : (
                      <span className="muted">not recorded</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* What this machine decided while it was on its own, and what any pause let through — the one
          record that used to die with the container (§3). Its own filter and counts live in the
          card; a pause id from the enforcement page deep-links straight to the filtered view. */}
      <NodeJournalCard nodeId={nodeId} />
    </div>
  );
}
