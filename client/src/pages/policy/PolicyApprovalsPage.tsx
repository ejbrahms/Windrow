import { useMemo, useState } from "react";
import { ApiError } from "../../api/client";
import { grantPayload, policy } from "../../api/policy";
import type { PolicyApproval, PolicyApprovalStatus } from "../../api/policy";
import { useFetch } from "../../api/useFetch";
import { count, list } from "../fleet/shared";
import { NameWithId, capabilityLabel, principalLabel, when } from "./shared";

/**
 * THE PROPOSAL QUEUE, AND THE RECORD OF EVERY DECISION — `GET /api/policy/approvals`,
 * `POST /api/policy/approvals/:id/decide` and `GET /api/policy/audit`.
 *
 * WHAT AN APPROVAL IS. A node holds a certificate that lets it *propose* — report a capability it
 * found, register a role it saw — and exactly one thing it may ask for rather than do:
 * `grant_capability`. That request lands here and grants nothing on its own. It is the confused-
 * deputy break in the design: the party that wants the permission is never the party that issues
 * it.
 *
 * APPROVING IS THE WRITE. `policyRoutes.js` creates the real grant inside the decision, in one
 * request — not "approve, then go and issue it", which would leave a window where the approval is
 * decided and the grant does not exist. `resultGrantId` on the decided row is the receipt.
 *
 * DELIBERATELY NOT REPLICATED. An approval decides nothing until it is approved, so no node ever
 * sees this queue — a replica of it would be a replica of a question. The grant it becomes is the
 * change nodes replicate, which is why the audit card below and not this queue is where the
 * fleet's history actually lives.
 */

const STATUS_TABS: { key: PolicyApprovalStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "denied", label: "Denied" },
];

export function PolicyApprovalsPage() {
  const [tab, setTab] = useState<PolicyApprovalStatus>("pending");
  const { data, loading, error, reload } = useFetch(() => policy.approvals.list({ status: tab }), [tab]);
  const { data: principalRows } = useFetch(() => policy.principals.list(), []);
  const { data: capabilityRows } = useFetch(() => policy.capabilities.list(), []);
  const {
    data: audit,
    loading: loadingAudit,
    error: auditError,
    reload: reloadAudit,
  } = useFetch(() => policy.audit({ limit: 100 }), []);

  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const principalById = useMemo(() => new Map(list(principalRows).map((p) => [p.id, p])), [principalRows]);
  const capabilityById = useMemo(() => new Map(list(capabilityRows).map((c) => [c.id, c])), [capabilityRows]);
  const approvals = useMemo(() => list(data), [data]);
  const entries = useMemo(() => list(audit?.entries), [audit]);

  async function decide(approval: PolicyApproval, status: "approved" | "denied") {
    setActionError(null);
    setBusy((b) => new Set(b).add(approval.id));
    try {
      await policy.approvals.decide(approval.id, status, `decided from the central dashboard`);
      reload();
      // The decision is itself an audited event when it issues a grant, so the log below is stale
      // the moment the button lands.
      reloadAudit();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : `Could not record the decision.`);
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(approval.id);
        return next;
      });
    }
  }

  /** A principal or capability id drawn as its name where one resolves, and as the id where none
   *  does — the same rule the rest of the control plane uses. */
  function principalCell(id: string | null) {
    if (!id) return <span className="muted">—</span>;
    return <NameWithId name={principalLabel(principalById.get(id))} id={id} />;
  }
  function capabilityCell(id: string | null) {
    if (!id) return <span className="muted">—</span>;
    return <NameWithId name={capabilityLabel(capabilityById.get(id))} id={id} />;
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Approvals</h1>
          <p>
            Grant requests a node proposed rather than issued. A node's certificate lets it report
            what it found and ask for a capability; it can never write a grant itself. Nothing here
            takes effect until it is approved, and approving issues the grant in the same request —
            so an approved row always has a real grant behind it.
          </p>
        </div>
      </div>

      {actionError && <div className="error-banner">{actionError}</div>}
      {error && <div className="error-banner">Could not load approvals: {error}</div>}

      <div className="tabs">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={"tab" + (tab === t.key ? " active" : "")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <div className="loading">Loading {tab} requests…</div>}

      {!loading && approvals.length === 0 && (
        <div className="card empty-state">
          {tab === "pending"
            ? "Nothing is waiting on a decision. A node proposes a grant only when something it ran needed a capability it did not hold."
            : `No ${tab} request has been recorded.`}
        </div>
      )}

      {!loading &&
        approvals.map((approval) => {
          const payload = grantPayload(approval);
          const principalId = approval.principalId ?? payload?.principalId ?? null;
          const capabilityId = approval.capabilityId ?? payload?.capabilityId ?? null;
          const isBusy = busy.has(approval.id);
          return (
            <div className="card" key={approval.id} style={{ marginBottom: 12 }}>
              <div className="grant-summary">
                <span className="badge badge-mutating">{approval.action}</span>
                <span>{capabilityCell(capabilityId)}</span>
                <span className="muted">for</span>
                <span>{principalCell(principalId)}</span>
              </div>
              <div className="desc muted" style={{ marginTop: 8 }}>
                Requested by the {approval.requestedByScope} scope at {when(approval.requestedAt)}
                {payload?.expiresAt ? ` — expires ${when(payload.expiresAt)}` : ""}
                {payload?.constraints ? ` — constrained: ${payload.constraints}` : ""}
              </div>
              {/* An action this page does not know how to describe still shows what it carries,
                  rather than a blank card. The queue is written by nodes; a shape asserted here
                  would be wrong the first time somebody adds one. */}
              {!payload && approval.payload != null && (
                <pre className="desc muted" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
                  {JSON.stringify(approval.payload, null, 2)}
                </pre>
              )}
              {approval.status === "pending" ? (
                <div className="grant-summary" style={{ marginTop: 8, gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isBusy}
                    onClick={() => decide(approval, "approved")}
                  >
                    Approve and issue the grant
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={isBusy}
                    onClick={() => decide(approval, "denied")}
                  >
                    Deny
                  </button>
                </div>
              ) : (
                <div className="desc muted" style={{ marginTop: 8 }}>
                  {approval.status === "approved" ? "Approved" : "Denied"} by the {approval.decidedByScope} scope
                  {approval.decidedAt ? ` at ${when(approval.decidedAt)}` : ""}
                  {approval.reason ? ` — ${approval.reason}` : ""}
                  {approval.resultGrantId ? ` — issued grant ${approval.resultGrantId}` : ""}
                </div>
              )}
            </div>
          );
        })}

      <div className="card">
        <h2>
          Control-plane audit{" "}
          {entries.length > 0 && <span className="muted">{count(entries.length)} most recent</span>}
        </h2>
        <p className="muted">
          Every capability registered, tier changed, principal updated, grant issued or revoked —
          written by central in the same transaction as the change itself. There is no node-side
          copy of this and there cannot be one: a control-plane change can only happen here now, so
          a table on a node could only ever be empty or wrong.
        </p>
        {auditError && <div className="error-banner">Could not load the audit log: {auditError}</div>}
        {loadingAudit && <div className="loading">Loading the audit log…</div>}
        {!loadingAudit && entries.length === 0 && (
          <div className="empty-state">
            Nothing has been recorded yet. The next grant issued or revoked from these pages appears
            here.
          </div>
        )}
        {!loadingAudit && entries.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Principal</th>
                <th>Capability</th>
                <th>By</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="muted">{when(entry.createdAt)}</td>
                  <td>
                    <span className="kind-pill">{entry.action}</span>
                  </td>
                  <td>{entry.principalId ? principalCell(entry.principalId) : <span className="muted">—</span>}</td>
                  <td>{entry.capabilityId ? capabilityCell(entry.capabilityId) : <span className="muted">—</span>}</td>
                  <td className="muted">
                    {entry.actorScope}
                    {entry.nodeId ? ` — ${entry.nodeId}` : ""}
                  </td>
                  <td className="muted">{entry.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
