import { useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { useFetch } from "../api/useFetch";
import type {
  Approval,
  ApprovalConsentPayload,
  ApprovalGrantPayload,
  ApprovalRevokePayload,
  ApprovalStatus,
} from "../api/types";
import { principalDisplayName } from "../api/principal";
import { useToast } from "../components/Toast";

const STATUS_TABS: { key: ApprovalStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "denied", label: "Denied" },
];

function isGrantPayload(action: Approval["action"], _payload: Approval["payload"]): _payload is ApprovalGrantPayload {
  return action === "grant";
}
function isRevokePayload(action: Approval["action"], _payload: Approval["payload"]): _payload is ApprovalRevokePayload {
  return action === "revoke";
}
function isConsentPayload(action: Approval["action"], _payload: Approval["payload"]): _payload is ApprovalConsentPayload {
  return action === "consent";
}

export function ApprovalsPage() {
  const [tab, setTab] = useState<ApprovalStatus>("pending");
  const { data: approvals, loading, error, reload } = useFetch(() => api.approvals.list({ status: tab }), [tab]);
  const { data: principals, reload: reloadPrincipals } = useFetch(() => api.principals.list(), []);
  const { data: capabilities } = useFetch(() => api.capabilities.list(), []);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const { showToast } = useToast();

  const principalById = useMemo(() => {
    const map = new Map((principals ?? []).map((p) => [p.id, p]));
    return map;
  }, [principals]);
  const capabilityById = useMemo(() => {
    const map = new Map((capabilities ?? []).map((c) => [c.id, c]));
    return map;
  }, [capabilities]);
  // A role's first sighting no longer
  // auto-grants it every read-only capability — it lands here instead, zero grants until an
  // admin looks at it. Only role principals ever hold direct grants (see findActiveGrant), so
  // that's the only kind worth surfacing; a pending instance has nothing of its own to approve.
  const pendingPrincipals = useMemo(
    () => (principals ?? []).filter((p) => p.status === "pending" && p.kind === "role"),
    [principals]
  );

  async function decide(approval: Approval, action: "approve" | "deny" | "extend") {
    setBusy((b) => new Set(b).add(approval.id));
    try {
      if (action === "approve") await api.approvals.approve(approval.id);
      else if (action === "deny") await api.approvals.deny(approval.id);
      else await api.approvals.extendGrant(approval.id, 1);
      reload();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : `Failed to ${action} the request.`, "error");
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(approval.id);
        return next;
      });
    }
  }

  async function decidePrincipal(id: string, action: "approve" | "deny") {
    setBusy((b) => new Set(b).add(id));
    try {
      if (action === "approve") await api.principals.approve(id);
      else await api.principals.deny(id);
      reloadPrincipals();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : `Failed to ${action} the principal.`, "error");
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Approvals</h1>
          <p>
            Destructive grant/revoke requests the governance MCP server proposed on an agent's behalf — it holds
            only a <em>proposer</em> token, which can queue a request here but never write a grant
            directly. Nothing here takes effect until you approve it.
            Consent records are different: they're a destructive call the harness's own prompt already
            approved once — this page is where you can extend one into a standing 1-hour grant instead.
          </p>
        </div>
      </div>

      {pendingPrincipals.length > 0 && (
        <>
          <h2>Pending principals</h2>
          <p className="muted">
            A role seen for the first time lands here with zero grants instead of being auto-provisioned.
            Approving applies the same read-only baseline every other role starts with; denying leaves it
            permanently ungranted.
          </p>
          {pendingPrincipals.map((principal) => {
            const isBusy = busy.has(principal.id);
            return (
              <div className="card" key={principal.id} style={{ marginBottom: 12 }}>
                <div className="grant-summary">
                  <span className="badge badge-mutating">Role</span>
                  <span>{principalDisplayName(principal)}</span>
                  {principal.backend && <span className="muted">via {principal.backend}</span>}
                </div>
                <div className="grant-summary" style={{ marginTop: 8, gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isBusy}
                    onClick={() => decidePrincipal(principal.id, "approve")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={isBusy}
                    onClick={() => decidePrincipal(principal.id, "deny")}
                  >
                    Deny
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}

      <h2>Requests</h2>
      {error && <div className="error-banner">Could not load approvals: {error}</div>}

      <div className="tabs">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            className={"tab" + (tab === t.key ? " active" : "")}
            onClick={() => setTab(t.key)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && <div className="loading">Loading…</div>}

      {!loading && (approvals ?? []).length === 0 && (
        <div className="card empty-state">No {tab} requests.</div>
      )}

      {!loading &&
        (approvals ?? []).map((approval) => {
          const principal = approval.principalId ? principalById.get(approval.principalId) : null;
          const capability = approval.capabilityId ? capabilityById.get(approval.capabilityId) : null;
          const isBusy = busy.has(approval.id);
          return (
            <div className="card" key={approval.id} style={{ marginBottom: 12 }}>
              <div className="grant-summary">
                <span
                  className={`badge badge-${approval.action === "revoke" ? "destructive" : approval.action === "consent" ? "destructive" : "mutating"}`}
                >
                  {approval.action === "revoke" ? "Revoke" : approval.action === "consent" ? "Consent" : "Grant"}
                </span>
                <span className="count tabular">
                  {capability ? capability.name : approval.capabilityId ?? "unknown capability"}
                </span>
                <span className="muted">for</span>
                <span>{principal ? principalDisplayName(principal) : approval.principalId ?? "unknown principal"}</span>
              </div>
              <div className="desc muted">
                Requested by the {approval.requestedByScope} token at {new Date(approval.requestedAt).toLocaleString()}
                {isGrantPayload(approval.action, approval.payload) && approval.payload.expiresAt
                  ? ` — expires ${new Date(approval.payload.expiresAt).toLocaleString()}`
                  : null}
                {isRevokePayload(approval.action, approval.payload) ? ` — grant ${approval.payload.grantId}` : null}
                {isConsentPayload(approval.action, approval.payload)
                  ? ` — approved once via the harness's own prompt (usage event ${approval.payload.usageEventId})`
                  : null}
              </div>
              {approval.status === "pending" ? (
                <div className="grant-summary" style={{ marginTop: 8, gap: 8 }}>
                  <button type="button" className="btn btn-primary" disabled={isBusy} onClick={() => decide(approval, "approve")}>
                    Approve
                  </button>
                  <button type="button" className="btn btn-danger" disabled={isBusy} onClick={() => decide(approval, "deny")}>
                    Deny
                  </button>
                </div>
              ) : (
                <div className="desc muted" style={{ marginTop: 8 }}>
                  {approval.status === "approved" ? "Approved" : "Denied"} by the {approval.decidedByScope} token
                  {approval.decidedAt ? ` at ${new Date(approval.decidedAt).toLocaleString()}` : ""}
                  {approval.reason ? ` — ${approval.reason}` : ""}
                </div>
              )}
              {approval.action === "consent" && approval.status === "approved" && (
                <div className="grant-summary" style={{ marginTop: 8, gap: 8 }}>
                  {approval.resultGrantId ? (
                    <span className="muted">Extended to a 1-hour grant ({approval.resultGrantId})</span>
                  ) : (
                    <>
                      <span className="muted">Approve once (default) or —</span>
                      <button type="button" className="btn btn-primary" disabled={isBusy} onClick={() => decide(approval, "extend")}>
                        Approve for an hour
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
