import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/client";
import { num } from "../../api/fleet";
import { activeGrants, policy, worstBehind } from "../../api/policy";
import type { PolicyCapability, PolicyGrant, PolicyPrincipal, PolicyRiskTier } from "../../api/policy";
import { useFetch } from "../../api/useFetch";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Toggle } from "../../components/Toggle";
import { count, list } from "../fleet/shared";
import { useToast } from "../../components/Toast";
import {
  CapabilityFilterBar,
  NameWithId,
  TIER_LABEL,
  TIER_ORDER,
  TierBadge,
  capabilityLabel,
  principalLabel,
  useCapabilityFilters,
  when,
} from "./shared";

/**
 * GRANTS, FLEET-WIDE — `GET/POST/DELETE /api/policy/grants`.
 *
 * THE SAME INTERACTION AS THE NODE'S ../GrantsPage.tsx, on purpose: pick a role or a person on the
 * left, then switch each capability on or off. That page was the one place this system's central
 * decision — who may do what — was ever actually made, and the shape of it is not worth
 * reinventing because the writer moved. What moved is the *reach*: a toggle here writes central's
 * `policy_changes` and every node in the fleet replicates it, so one click is thirty machines.
 *
 * WHAT IS GRANTABLE, AND WHY IT IS EXACTLY TWO KINDS. Roles and people, never instances — an
 * instance inherits its parent role's grants dynamically, so a grant row of its own would add
 * nothing and would immediately start drifting from the role it was supposed to follow. A person
 * is the opposite case: `parentRole` is null on a user row because a person is not an agent, so
 * they inherit from nothing and hold only what is granted here. Under
 * docs/design/grant-resolution-semantics.md the effective decision is the intersection of the two
 * legs, which is why both are in the same list rather than on two pages.
 *
 * SKILLS ARE NOT FILTERED OUT HERE, and that is the one deliberate difference from the node's
 * page. A node excludes them because skills are not governed on a node; central's catalog is
 * fleet-wide and sixty-two of its live grants point at `skill` rows. Hiding them would mean the
 * only page that can revoke a grant could not see sixty-two of them.
 *
 * A REVOKE IS A SOFT DELETE AND THE LIST RETURNS REVOKED ROWS — everything below counts through
 * `activeGrants` for that reason. The revoked row is not noise: its `revokedAt` is what puts the
 * grant on the deny-list every node fetches in full on every poll, which is what makes taking
 * permission away survive a broken delta stream.
 */
export function PolicyGrantsPage() {
  const { data: principalRows, loading: loadingPrincipals, error: principalsError } = useFetch(
    () => policy.principals.list(),
    [],
  );
  const { data: capabilityRows, loading: loadingCapabilities, error: capabilitiesError } = useFetch(
    () => policy.capabilities.list(),
    [],
  );
  // EVERY grant in one request, rather than one request per principal as the node does. There are
  // hundreds, not millions, and holding them all is what lets the left-hand column show a count
  // beside each name — "which roles actually hold anything" is the first question this page is
  // asked, and it cannot be answered one selection at a time.
  const { data: grantRows, loading: loadingGrants, error: grantsError } = useFetch(() => policy.grants.list(), []);
  // How far behind the fleet is. On a page whose whole subject is taking permission away, "when
  // does this land" is not a footnote — see `GET /api/fleet/policy`.
  const { data: replication } = useFetch(() => policy.nodeState(), []);

  const [grants, setGrants] = useState<PolicyGrant[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const { showToast } = useToast();
  const [grantTarget, setGrantTarget] = useState<PolicyCapability | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ grant: PolicyGrant; label: string } | null>(null);

  useEffect(() => setGrants(grantRows), [grantRows]);

  const principals = useMemo(() => list(principalRows), [principalRows]);
  const capabilities = useMemo(() => list(capabilityRows), [capabilityRows]);
  const live = useMemo(() => activeGrants(grants), [grants]);

  const capabilityById = useMemo(() => new Map(capabilities.map((c) => [c.id, c])), [capabilities]);

  const roles = useMemo(() => principals.filter((p) => p.kind === "role"), [principals]);
  const users = useMemo(() => principals.filter((p) => p.kind === "user"), [principals]);

  const liveCountByPrincipal = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of live) map.set(g.principalId, (map.get(g.principalId) ?? 0) + 1);
    return map;
  }, [live]);

  // Default to the role holding the most, not to principals[0]: the first row is usually a role
  // nobody has granted anything, so landing there opens a page full of real data on an empty one.
  //
  // AND NOT UNTIL THE GRANTS HAVE ARRIVED. `grants === null` means the request is still in flight,
  // and ranking on counts that are all zero picks the first role in the list — which is exactly the
  // row this is trying to avoid, and then never re-runs because `selectedId` is set. Measured
  // against the live central: it landed on `tester`, 0 grants, with 481 in the table beside it.
  useEffect(() => {
    if (selectedId || grants === null || roles.length === 0) return;
    const best = [...roles].sort(
      (a, b) => (liveCountByPrincipal.get(b.id) ?? 0) - (liveCountByPrincipal.get(a.id) ?? 0),
    )[0];
    if (best) setSelectedId(best.id);
  }, [roles, liveCountByPrincipal, selectedId, grants]);

  const selected: PolicyPrincipal | null = useMemo(
    () => principals.find((p) => p.id === selectedId) ?? null,
    [principals, selectedId],
  );

  const selectedGrants = useMemo(() => live.filter((g) => g.principalId === selectedId), [live, selectedId]);
  const grantByCapabilityId = useMemo(() => {
    const map = new Map<string, PolicyGrant>();
    for (const g of selectedGrants) map.set(g.capabilityId, g);
    return map;
  }, [selectedGrants]);

  // A live grant whose capability is not in the catalog. Central holds four of these today, all
  // pointing at one id that no capability row answers to. They are invisible to the tier list
  // below — it iterates capabilities, not grants — and a grant you cannot see is a grant you
  // cannot revoke, which on this page is the one failure that matters.
  const unresolved = useMemo(
    () => selectedGrants.filter((g) => !capabilityById.has(g.capabilityId)),
    [selectedGrants, capabilityById],
  );

  const filters = useCapabilityFilters(capabilities);
  const grouped = useMemo(() => {
    const map = new Map<PolicyRiskTier, PolicyCapability[]>(TIER_ORDER.map((t) => [t, []]));
    for (const c of filters.filtered) map.get(c.riskTier)?.push(c);
    for (const caps of map.values()) caps.sort((a, b) => (capabilityLabel(a) ?? "").localeCompare(capabilityLabel(b) ?? ""));
    return map;
  }, [filters.filtered]);

  const grantedCount = capabilities.filter((c) => c.autoGrant || grantByCapabilityId.has(c.id)).length;

  function markPending(id: string, on: boolean) {
    setPending((p) => {
      const next = new Set(p);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function grant(capability: PolicyCapability) {
    if (!selectedId) return;
    markPending(capability.id, true);
    try {
      const created = await policy.grants.create({
        principalId: selectedId,
        capabilityId: capability.id,
        reason: "granted from the central dashboard",
      });
      setGrants((prev) => [...(prev ?? []), created]);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not issue the grant.", "error");
    } finally {
      markPending(capability.id, false);
    }
  }

  async function revoke(target: PolicyGrant) {
    markPending(target.capabilityId, true);
    try {
      const revoked = await policy.grants.revoke(target.id, "revoked from the central dashboard");
      // Replaced, not removed: the row survives with `revokedAt` set, which is the whole point of a
      // soft delete, and keeping it in state means the history card below stays honest.
      setGrants((prev) => (prev ?? []).map((g) => (g.id === revoked.id ? revoked : g)));
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Could not revoke the grant.", "error");
    } finally {
      markPending(target.capabilityId, false);
    }
  }

  function handleToggle(capability: PolicyCapability, next: boolean) {
    if (capability.autoGrant) return; // locked on; the toggle is disabled, this guards a stray call
    const existing = grantByCapabilityId.get(capability.id);
    if (next) {
      if (capability.riskTier === "destructive") {
        setGrantTarget(capability);
        return;
      }
      grant(capability);
    } else if (existing) {
      setRevokeTarget({ grant: existing, label: capabilityLabel(capability) ?? capability.id });
    }
  }

  const loading = loadingPrincipals || loadingCapabilities;
  const loadError = principalsError || capabilitiesError || grantsError;
  const behind = worstBehind(replication);
  const centralVersion = num(replication?.centralVersion ?? null);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Grants</h1>
          <p>
            Pick a role or a person, then grant or revoke each capability. Every running instance of
            a role inherits that role's grants automatically; a person inherits nothing and holds
            only what is granted here, and a call is allowed only where both legs agree. Central is
            the single writer — one toggle here is written once and replicated to every node.
          </p>
        </div>
      </div>

      {loadError && <div className="error-banner">Could not load data: {loadError}</div>}

      <div className="card">
        <div className="grant-summary">
          <span className="count tabular">{count(live.length)}</span>
          <span className="muted">live grants across the fleet</span>
          <span className="muted">
            — policy version {centralVersion === null ? "—" : centralVersion.toLocaleString()}
            {behind === null
              ? ", no node has pulled yet"
              : behind === 0
                ? ", every node up to date"
                : `, worst node ${behind.toLocaleString()} changes behind`}
          </span>
          {loadingGrants && <span className="muted">(loading…)</span>}
        </div>
        <p className="muted" style={{ margin: "8px 0 0" }}>
          A revoke takes effect on a node when that node next pulls, and rides the deny-list on
          every poll so it lands even where the delta stream is broken. The version above is what
          that lag is measured in — see <a href="#/fleet/nodes">Nodes</a> for who is behind.
        </p>
      </div>

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
                <span className="muted">
                  {count(liveCountByPrincipal.get(role.id) ?? 0)} grants
                  {role.status === "active" ? "" : ` — ${role.status}`}
                </span>
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
                    <span>{principalLabel(user)}</span>
                    <span className="muted">
                      {count(liveCountByPrincipal.get(user.id) ?? 0)} grants
                      {user.status === "active" ? "" : ` — ${user.status}`}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>

          <div>
            {!selected && <div className="card empty-state">Select a role or a person to see what they hold.</div>}
            {selected && (
              <div className="card">
                <div className="grant-summary">
                  <h2 style={{ margin: 0 }}>
                    {principalLabel(selected)} <span className="muted">{selected.kind}</span>
                  </h2>
                  <code className="muted">{selected.id}</code>
                </div>

                {selected.status !== "active" && (
                  <p className="muted">
                    This principal is <strong>{selected.status}</strong>, so it is on the deny-list
                    every node fetches and none of the grants below apply to it right now. They stay
                    on the books, and activating it on the <a href="#/policy/principals">Principals</a>{" "}
                    page brings them all back at once.
                  </p>
                )}
                {selected.kind === "user" && (
                  <p className="muted">
                    A person's grants are a ceiling, not an inheritance: an agent may do something
                    only if both this person and the agent's role allow it. Nothing here comes from
                    a role, so what you grant is exactly what this person can authorise.
                  </p>
                )}

                <div className="grant-summary">
                  <span className="count tabular">
                    {grantedCount} of {capabilities.length}
                  </span>
                  <span className="muted">capabilities held</span>
                </div>

                {unresolved.length > 0 && <UnresolvedGrants grants={unresolved} onRevoke={setRevokeTarget} pending={pending} />}

                <CapabilityFilterBar
                  state={filters}
                  countLabel={`${filters.filtered.length} of ${capabilities.length} shown`}
                />

                {filters.filtered.length === 0 && (
                  <div className="empty-state">No capability matches these filters.</div>
                )}

                {TIER_ORDER.map((tier) => {
                  const caps = grouped.get(tier) ?? [];
                  if (caps.length === 0) return null;
                  const held = caps.filter((c) => c.autoGrant || grantByCapabilityId.has(c.id)).length;
                  return (
                    <div className="tier-group" key={tier}>
                      <h3>
                        <TierBadge tier={tier} /> {TIER_LABEL[tier]}
                        <span className="muted" style={{ fontWeight: 400 }}>
                          {" "}
                          ({held}/{caps.length})
                        </span>
                      </h3>
                      {caps.map((c) => {
                        const existing = grantByCapabilityId.get(c.id);
                        const isGranted = c.autoGrant || Boolean(existing);
                        const isPending = pending.has(c.id);
                        return (
                          <div className="grant-row" key={c.id}>
                            <div className="info">
                              <div className="name">{capabilityLabel(c)}</div>
                              <div className="desc muted" title={c.description ?? undefined}>
                                <code>{c.id}</code>
                                {c.owner ? ` — ${c.owner}` : ""}
                                {c.description ? ` — ${c.description}` : ""}
                                {existing ? ` — granted ${when(existing.createdAt)}` : ""}
                              </div>
                            </div>
                            <Toggle
                              checked={isGranted}
                              disabled={isPending || c.autoGrant}
                              label={
                                c.autoGrant
                                  ? `${capabilityLabel(c)} is auto-granted to every principal — not managed per-principal here.`
                                  : `${isGranted ? "Revoke" : "Grant"} ${capabilityLabel(c)} for ${principalLabel(selected)}`
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

      {grantTarget && (
        <ConfirmDialog
          title="Grant a destructive capability"
          message={`"${capabilityLabel(grantTarget)}" is tier-destructive${
            grantTarget.description ? ` (${grantTarget.description})` : ""
          }. Granting it to ${
            selected ? principalLabel(selected) : "this principal"
          } lets it take irreversible action on every node in the fleet. Continue?`}
          confirmLabel="Grant anyway"
          danger
          onCancel={() => setGrantTarget(null)}
          onConfirm={() => {
            const target = grantTarget;
            setGrantTarget(null);
            grant(target);
          }}
        />
      )}

      {revokeTarget && (
        <ConfirmDialog
          title="Revoke this grant"
          message={`${
            selected ? principalLabel(selected) : "This principal"
          } loses "${revokeTarget.label}" on every node in the fleet. The grant row is kept with the time and the scope that revoked it, and the revocation rides the deny-list on every poll — so it lands even on a node whose delta stream is broken.${
            behind && behind > 0 ? ` The worst node is ${behind.toLocaleString()} changes behind right now.` : ""
          }`}
          confirmLabel="Revoke it"
          danger
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => {
            const target = revokeTarget;
            setRevokeTarget(null);
            revoke(target.grant);
          }}
        />
      )}
    </div>
  );
}

/**
 * Grants pointing at a capability this catalog cannot name.
 *
 * Rendered as a row of its own rather than folded into the tier list, because there is nothing to
 * fold it into: the list below iterates the CATALOG, so a grant whose capability is missing from
 * the catalog has no row to appear in. The id stands alone — the established rule where nothing
 * resolves — and the only control offered is the one that still means something.
 */
function UnresolvedGrants({
  grants,
  onRevoke,
  pending,
}: {
  grants: PolicyGrant[];
  onRevoke: (target: { grant: PolicyGrant; label: string }) => void;
  pending: Set<string>;
}) {
  return (
    <div className="tier-group">
      <h3>
        <span className="badge badge-error">Unresolved</span> Not in the catalog
        <span className="muted" style={{ fontWeight: 400 }}>
          {" "}
          ({grants.length})
        </span>
      </h3>
      <p className="muted">
        These are live grants whose capability id no row in central's catalog answers to, so nothing
        can say what they permit. They still count against this principal and they can still be
        revoked.
      </p>
      {grants.map((g) => (
        <div className="grant-row" key={g.id}>
          <div className="info">
            <div className="name">
              <NameWithId name={null} id={g.capabilityId} />
            </div>
            <div className="desc muted">
              grant <code>{g.id}</code> — issued {when(g.createdAt)}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-danger"
            disabled={pending.has(g.capabilityId)}
            onClick={() => onRevoke({ grant: g, label: g.capabilityId })}
          >
            Revoke
          </button>
        </div>
      ))}
    </div>
  );
}
