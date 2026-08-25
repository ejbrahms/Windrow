import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { useFetch } from "../api/useFetch";
import type { Capability, Grant, Principal, RiskTier } from "../api/types";
import { principalDisplayName } from "../api/principal";
import { RiskBadge } from "../components/Badge";
import { Toggle } from "../components/Toggle";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CapabilityFilterBar, useCapabilityFilters } from "../components/CapabilityFilters";
import { useToast } from "../components/Toast";

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
  // Skills aren't governed — no grants, no usage tracking (docs/design/skill-mcp-governance.md
  // §0) — so Grants only ever deals in MCP tools. Manage skills from the Skills page instead.
  const capabilities = useMemo(() => (allCapabilities ?? []).filter((c) => c.kind === "mcp_tool"), [allCapabilities]);
  const { data: packages } = useFetch(() => api.packages.list(), []);
  // Same kind/risk-tier/package filters as the Catalog page (client/src/components/CapabilityFilters.tsx)
  // — narrows which capabilities are *shown* below, same as there. "Granted" coverage in the header
  // stays measured against the full curated list regardless of filter, so switching the Package
  // filter to "Gmail" doesn't make it look like the role's overall coverage suddenly changed.
  const filters = useCapabilityFilters(capabilities, packages);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [grantsLoading, setGrantsLoading] = useState(false);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [confirmTarget, setConfirmTarget] = useState<Capability | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ capability: Capability; grantId: string } | null>(null);
  const { showToast } = useToast();

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
    for (const c of filters.filtered) map.get(c.riskTier)?.push(c);
    return map;
  }, [filters.filtered]);

  // WHAT IS GRANTABLE HERE, AND WHY IT IS EXACTLY TWO KINDS.
  //
  // Roles and people, never instances. An instance principal inherits its parent role's grants
  // dynamically (server/app.js's findActiveGrant falls back to the role when the instance has no
  // grant row of its own), so there is nothing for an instance row to add — and listing instances
  // alongside their role invited granting them individually, which drifts from the role and stops
  // being "inherited" the moment someone does.
  //
  // A `user` principal is the opposite case, and leaving it out was a real gap rather than a
  // simplification. Under docs/design/grant-resolution-semantics.md the effective decision is the
  // intersection of a *user leg* and a *role ceiling*, and a user row carries `parentRole: null`
  // on purpose — a person is not an agent, so it inherits from nothing and can only hold grants of
  // its own. With this list filtered to roles there was no way to give it any: the user principal
  // was created with zero grants, `POST /api/principals/:id/approve` issued its read-only baseline
  // only to roles, and nothing else ever wrote one. So every user-leg evaluation denied, which the
  // shadow evaluator had been recording all along.
  const roles: Principal[] = useMemo(
    () => (principals ?? []).filter((p) => p.kind === "role"),
    [principals],
  );
  const users: Principal[] = useMemo(
    () => (principals ?? []).filter((p) => p.kind === "user"),
    [principals],
  );

  async function grant(capability: Capability) {
    if (!selectedId) return;
    setPending((p) => new Set(p).add(capability.id));
    try {
      const created = await api.grants.create({ principalId: selectedId, capabilityId: capability.id });
      setGrants((prev) => [...(prev ?? []), created]);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to grant capability.", "error");
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(capability.id);
        return next;
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // TEMPORARY, DEVELOPMENT ONLY — remove this block and `grantAll` below when it stops being useful.
  //
  // WHY IT IS GATED RATHER THAN JUST LABELLED. `import.meta.env.DEV` is a compile-time constant, so
  // `vite build` folds this to `false` and drops the button, the handler and this comment from the
  // production bundle entirely. A run-time flag would ship a one-click "grant every capability,
  // destructive included" control to every install and leave only a label between an operator and
  // using it — which is the same shape of mistake as the admin token that used to be compiled into
  // this bundle (docs/design/per-node-enrollment-credentials.md). Deleting this block is therefore
  // safe and self-contained: nothing outside it refers to `grantAll`.
  //
  // It exists because setting up a realistic dev fixture means granting ~40 capabilities one toggle
  // at a time, and doing that by hand is how people end up testing against a principal that holds
  // a different set from the one they meant.
  const DEV_GRANT_ALL = import.meta.env.DEV;
  const [grantingAll, setGrantingAll] = useState(false);

  /** Grant every not-yet-granted capability to the selected principal, destructive tiers included —
   *  the confirmation the normal toggle requires is deliberately skipped, because the whole point
   *  is one click. Sequential, not parallel: each POST is a policy write that on a replica node is
   *  proxied to central, and firing forty at once is how you find out what its rate limits are. */
  async function grantAll() {
    if (!selectedId || grantingAll) return;
    const missing = capabilities.filter((c) => !c.autoGranted && !grantByCapabilityId.has(c.id));
    if (missing.length === 0) return;
    setGrantingAll(true);
    const created: Grant[] = [];
    const failed: string[] = [];
    for (const capability of missing) {
      try {
        // eslint-disable-next-line no-await-in-loop
        created.push(await api.grants.create({ principalId: selectedId, capabilityId: capability.id }));
      } catch (err) {
        // A 409 means someone else granted it between the read and the write — not a failure worth
        // reporting. Anything else is, and one bad capability must not cost the rest their grant.
        if (!(err instanceof ApiError && err.status === 409)) failed.push(capability.name);
      }
    }
    setGrants((prev) => [...(prev ?? []), ...created]);
    if (failed.length > 0) {
      showToast(
        `Granted ${created.length} of ${missing.length}. Failed: ${failed.slice(0, 5).join(", ")}` +
          (failed.length > 5 ? ` and ${failed.length - 5} more.` : "."),
        "error",
      );
    }
    setGrantingAll(false);
  }
  // --------------------------------------------------------------------------- end dev-only block

  async function revoke(capability: Capability, grantId: string) {
    setPending((p) => new Set(p).add(capability.id));
    try {
      await api.grants.remove(grantId);
      setGrants((prev) => (prev ?? []).filter((g) => g.id !== grantId));
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to revoke capability.", "error");
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(capability.id);
        return next;
      });
    }
  }

  function handleToggle(capability: Capability, next: boolean) {
    if (capability.autoGranted) return; // toggle is disabled for these; guard in case of a stray call
    const existing = grantByCapabilityId.get(capability.id);
    if (next) {
      if (capability.riskTier === "destructive") {
        setConfirmTarget(capability);
        return;
      }
      grant(capability);
    } else if (existing) {
      setRevokeTarget({ capability, grantId: existing.id });
    }
  }

  // Auto-granted capabilities (server/store.js's per-capability `autoGrant` column) count as granted here even
  // without a grant row — that's exactly what "auto" means, and the toggle below is disabled for
  // them for the same reason (there's nothing a grant/revoke call here would actually change).
  const grantedCount = capabilities.filter((c) => c.autoGranted || grantByCapabilityId.has(c.id)).length;
  const totalCount = capabilities.length;

  const loading = loadingPrincipals || loadingCapabilities;
  const error = principalsError || capabilitiesError;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Grants</h1>
          <p>
            Pick a role or a person, then grant or revoke each MCP tool. Every instance of a role inherits
            that role's grants automatically; a person inherits nothing, and holds only what you grant here.
            Destructive grants need confirmation. A few capabilities (wispfield's own
            orchestration tools) are always granted to every principal and show up locked "on" — toggling
            them here wouldn't change anything real. Skills aren't governed here — see the{" "}
            <a href="#/skills">Skills</a> page to manage those.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load data: {error}</div>}

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
            {users.length > 0 && (
              <>
                <h2>People</h2>
                {users.map((user) => (
                  <button
                    key={user.id}
                    className={selectedId === user.id ? "active" : undefined}
                    onClick={() => setSelectedId(user.id)}
                  >
                    <span>{principalDisplayName(user)}</span>
                    <span className="muted">user</span>
                  </button>
                ))}
              </>
            )}
          </div>

          <div>
            {!selectedPrincipal && <div className="card empty-state">Select a role or a person to view their grants.</div>}
            {selectedPrincipal && (
              <div className="card">
                <div className="grant-summary">
                  <h2 style={{ margin: 0 }}>
                    {principalDisplayName(selectedPrincipal)}{" "}
                    <span className="muted">{selectedPrincipal.kind}</span>
                  </h2>
                </div>
                {selectedPrincipal.kind === "user" && (
                  <p className="muted">
                    A person's grants are a ceiling, not an inheritance: an agent may do something only
                    if both this person and the agent's role allow it. Nothing here is inherited from a
                    role, so what you grant is exactly what this person can authorise.
                  </p>
                )}
                <div className="grant-summary">
                  <span className="count tabular">
                    {grantedCount} of {totalCount}
                  </span>
                  <span className="muted">capabilities granted</span>
                  {grantsLoading && <span className="muted">(refreshing…)</span>}
                  {/* TEMPORARY, DEVELOPMENT ONLY — see the grantAll block above. Compiled out of
                      production builds by `import.meta.env.DEV`; delete both together. */}
                  {DEV_GRANT_ALL && (
                    <button
                      type="button"
                      onClick={grantAll}
                      disabled={grantingAll || grantedCount >= totalCount}
                      title="Development only: grants every capability, destructive tiers included, with no confirmation. Not present in a production build."
                    >
                      {grantingAll ? "Granting…" : "Grant all (dev)"}
                    </button>
                  )}
                </div>

                {grantsError && <div className="error-banner">Could not load grants: {grantsError}</div>}

                <CapabilityFilterBar
                  state={filters}
                  packages={packages}
                  countLabel={`${filters.filtered.length} of ${capabilities.length} shown`}
                  hideKindFilter
                />

                {filters.filtered.length === 0 && (
                  <div className="empty-state">No capabilities match these filters.</div>
                )}

                {TIER_ORDER.map((tier) => {
                  const caps = grouped.get(tier) ?? [];
                  if (caps.length === 0) return null;
                  return (
                    <div className="tier-group" key={tier}>
                      <h3>
                        <RiskBadge tier={tier} /> {TIER_LABEL[tier]}
                        <span className="muted" style={{ fontWeight: 400 }}>
                          ({caps.filter((c) => c.autoGranted || grantByCapabilityId.has(c.id)).length}/{caps.length})
                        </span>
                      </h3>
                      {caps.map((c) => {
                        const isGranted = c.autoGranted || grantByCapabilityId.has(c.id);
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
                              disabled={isPending || c.autoGranted}
                              label={
                                c.autoGranted
                                  ? `${c.name} is always granted to every principal — not managed per-role here.`
                                  : `${isGranted ? "Revoke" : "Grant"} ${c.name} for ${principalDisplayName(selectedPrincipal)}`
                              }
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

      {revokeTarget && (
        <ConfirmDialog
          title="Revoke a capability"
          message={`Revoke "${revokeTarget.capability.name}" from ${
            selectedPrincipal ? principalDisplayName(selectedPrincipal) : "this principal"
          }? They'll no longer be able to use it.`}
          confirmLabel="Revoke"
          danger
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => {
            const target = revokeTarget;
            setRevokeTarget(null);
            revoke(target.capability, target.grantId);
          }}
        />
      )}
    </div>
  );
}
