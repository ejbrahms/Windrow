import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { useFetch } from "../api/useFetch";
import type { Capability, Grant, Principal, RiskTier } from "../api/types";
import { principalDisplayName } from "../api/principal";
import { RiskBadge } from "../components/Badge";
import { Toggle } from "../components/Toggle";
import { ConfirmDialog } from "../components/ConfirmDialog";

const TIER_ORDER: RiskTier[] = ["read_only", "mutating", "destructive"];
const TIER_LABEL: Record<RiskTier, string> = {
  read_only: "Read-only",
  mutating: "Mutating",
  destructive: "Destructive",
};

export function GrantsPage() {
  const { data: principals, loading: loadingPrincipals, error: principalsError } = useFetch(
    () => api.principals.list(),
    [],
  );
  const { data: allCapabilities, loading: loadingCapabilities, error: capabilitiesError } = useFetch(
    () => api.capabilities.list(),
    [],
  );
  // Wispfield's own MCP tools (spawn/dispatch/report/...) are auto-granted to every principal —
  // server/app.js's findActiveGrant never even checks a grant row for them — so there's nothing
  // to curate here. Hiding them keeps this page to capabilities a human actually decides on; they
  // still show up in the usage dashboard (DashboardPage.tsx), just filterable there.
  const capabilities = useMemo(
    () => (allCapabilities ?? []).filter((c) => c.owner !== "wispfield"),
    [allCapabilities],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [confirmTarget, setConfirmTarget] = useState<Capability | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Default to the first role once the list loads — instances aren't selectable here, so picking
  // principals[0] could land on one and leave selectedId pointing at a principal with no button.
  useEffect(() => {
    if (!selectedId && principals && principals.length > 0) {
      const firstRole = principals.find((p) => p.kind === "role");
      if (firstRole) setSelectedId(firstRole.id);
    }
  }, [principals, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setGrantsLoading(true);
    setGrantsError(null);
    api.grants
      .list({ principalId: selectedId })
      .then((g) => !cancelled && setGrants(g))
      .catch((err: unknown) => !cancelled && setGrantsError(err instanceof Error ? err.message : String(err)))
      .finally(() => !cancelled && setGrantsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selectedPrincipal = useMemo(
    () => principals?.find((p) => p.id === selectedId) ?? null,
    [principals, selectedId],
  );

  const grantByCapabilityId = useMemo(() => {
    const map = new Map<string, Grant>();
    for (const g of grants ?? []) map.set(g.capabilityId, g);
    return map;
  }, [grants]);

  const grouped = useMemo(() => {
    const map = new Map<RiskTier, Capability[]>();
    for (const tier of TIER_ORDER) map.set(tier, []);
    for (const c of capabilities ?? []) map.get(c.riskTier)?.push(c);
    return map;
  }, [capabilities]);

  // Grants are managed per role only — an instance principal inherits its parent role's grants
  // dynamically (server/app.js's findActiveGrant falls back to the role when the instance has no
  // grant row of its own), so there's nothing for an instance row to add here. Listing instances
  // alongside their role invited granting them individually, which drifts from the role and stops
  // being "inherited" the moment someone does that.
  const roles: Principal[] = useMemo(
    () => (principals ?? []).filter((p) => p.kind === "role"),
    [principals],
  );

  async function grant(capability: Capability) {
    if (!selectedId) return;
    setActionError(null);
    setPending((p) => new Set(p).add(capability.id));
    try {
      const created = await api.grants.create({ principalId: selectedId, capabilityId: capability.id });
      setGrants((prev) => [...(prev ?? []), created]);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to grant capability.");
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(capability.id);
        return next;
      });
    }
  }

  async function revoke(capability: Capability, grantId: string) {
    setActionError(null);
    setPending((p) => new Set(p).add(capability.id));
    try {
      await api.grants.remove(grantId);
      setGrants((prev) => (prev ?? []).filter((g) => g.id !== grantId));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to revoke capability.");
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(capability.id);
        return next;
      });
    }
  }

  function handleToggle(capability: Capability, next: boolean) {
    const existing = grantByCapabilityId.get(capability.id);
    if (next) {
      if (capability.riskTier === "destructive") {
        setConfirmTarget(capability);
        return;
      }
      grant(capability);
    } else if (existing) {
      revoke(capability, existing.id);
    }
  }

  // Counted against the visible (non-Wispfield) capability list, not the raw grants array — a
  // principal may hold grant rows for auto-granted Wispfield capabilities from before that policy
  // existed, and those shouldn't inflate this count since the capability itself is hidden above.
  const grantedCount = capabilities.filter((c) => grantByCapabilityId.has(c.id)).length;
  const totalCount = capabilities.length;

  const loading = loadingPrincipals || loadingCapabilities;
  const error = principalsError || capabilitiesError;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Grants</h1>
          <p>
            Pick a role, then grant or revoke each capability. Every instance of that role inherits its grants
            automatically. Destructive grants need confirmation.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load data: {error}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      {loading && <div className="loading">Loading…</div>}

      {!loading && (
        <div className="grants-layout">
          <div className="card principal-list">
            <h2>Roles</h2>
            {roles.map((role) => (
              <button
                key={role.id}
                className={selectedId === role.id ? "active" : undefined}
                onClick={() => setSelectedId(role.id)}
              >
                <span>{role.name}</span>
                <span className="muted">role</span>
              </button>
            ))}
          </div>

          <div>
            {!selectedPrincipal && <div className="card empty-state">Select a role to view its grants.</div>}
            {selectedPrincipal && (
              <div className="card">
                <div className="grant-summary">
                  <h2 style={{ margin: 0 }}>
                    {principalDisplayName(selectedPrincipal)} <span className="muted">role</span>
                  </h2>
                </div>
                <div className="grant-summary">
                  <span className="count tabular">
                    {grantedCount} of {totalCount}
                  </span>
                  <span className="muted">capabilities granted</span>
                  {grantsLoading && <span className="muted">(refreshing…)</span>}
                </div>

                {grantsError && <div className="error-banner">Could not load grants: {grantsError}</div>}

                {TIER_ORDER.map((tier) => {
                  const caps = grouped.get(tier) ?? [];
                  if (caps.length === 0) return null;
                  return (
                    <div className="tier-group" key={tier}>
                      <h3>
                        <RiskBadge tier={tier} /> {TIER_LABEL[tier]}
                        <span className="muted" style={{ fontWeight: 400 }}>
                          ({caps.filter((c) => grantByCapabilityId.has(c.id)).length}/{caps.length})
                        </span>
                      </h3>
                      {caps.map((c) => {
                        const isGranted = grantByCapabilityId.has(c.id);
                        const isPending = pending.has(c.id);
                        return (
                          <div className="grant-row" key={c.id}>
                            <div className="info">
                              <div className="name">{c.name}</div>
                              <div className="desc" title={c.description}>
                                {c.owner} — {c.description}
                              </div>
                            </div>
                            <Toggle
                              checked={isGranted}
                              disabled={isPending}
                              label={`${isGranted ? "Revoke" : "Grant"} ${c.name} for ${principalDisplayName(
                                selectedPrincipal,
                              )}`}
                              onChange={(next) => handleToggle(c, next)}
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {confirmTarget && (
        <ConfirmDialog
          title="Grant a destructive capability"
          message={`"${confirmTarget.name}" is tier-destructive (${confirmTarget.description}). Granting it to ${
            selectedPrincipal ? principalDisplayName(selectedPrincipal) : "this principal"
          } lets it take irreversible action. Continue?`}
          confirmLabel="Grant anyway"
          danger
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => {
            const target = confirmTarget;
            setConfirmTarget(null);
            grant(target);
          }}
        />
      )}
    </div>
  );
}
