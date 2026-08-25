import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fleet } from "../../api/fleet";
import type {
  IntegrationDetail,
  IntegrationDetailCapability,
  IntegrationDetailTier,
  IntegrationGrantCell,
} from "../../api/fleet";
import { policy } from "../../api/policy";
import { ApiError } from "../../api/client";
import { useFetch } from "../../api/useFetch";
import { StatTile } from "../../components/StatTile";
import { Toggle } from "../../components/Toggle";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { LiveControl } from "../../components/LiveControl";
import { useAutoRefresh } from "../../hooks/useAutoRefresh";
import { count } from "./shared";
import { TIER_LABEL, TierBadge } from "../policy/shared";
import { useToast } from "../../components/Toast";

/**
 * ONE INTEGRATION OR PROVIDER, IN FULL — the drill-down behind a card on the Integrations page.
 *
 * That page manages a package as a whole: enable it, sync its defaults, revoke everything. This is
 * the level below — every capability the package owns, grouped by risk tier, crossed with the roles
 * its policy targets, and a toggle on each (capability × role) pair. The aggregate "12 / 40 granted"
 * on the card cannot say WHICH twelve or let you change exactly one; this can.
 *
 * A TABLE PER TIER, ROLES ACROSS THE TOP. Within one tier every capability targets the same set of
 * roles (the policy is keyed by tier, so `read_only`'s roles are the same for every read-only tool),
 * which is what makes the matrix rectangular and a table the honest shape for it. A capability the
 * package's default policy would NOT grant on Sync still appears — marked "not a default" rather
 * than hidden — so "the package never grants this" reads as distinct from "nobody has yet."
 *
 * THE TOGGLES ARE ORDINARY GRANTS. Each writes `/api/policy/grants` (create or revoke), the same
 * central writer every other grant goes through, so one flip here replicates to every node on the
 * next poll exactly as the per-principal Grants page does. This page adds a lens, not a new writer.
 */
export function FleetIntegrationDetailPage() {
  const { id = "" } = useParams();
  const { data, loading, error, reload } = useFetch(() => fleet.integrationDetail(id), [id]);
  const auto = useAutoRefresh({
    storageKey: "fleet-integration-detail-auto-refresh",
    reload,
    dataSignal: data,
  });

  const [detail, setDetail] = useState<IntegrationDetail | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const { showToast } = useToast();
  const [destructiveGrant, setDestructiveGrant] = useState<
    { cap: IntegrationDetailCapability; cell: IntegrationGrantCell } | null
  >(null);

  useEffect(() => setDetail(data), [data]);

  const totals = useMemo(() => {
    let granted = 0;
    let total = 0;
    for (const tier of detail?.tiers ?? []) {
      for (const cap of tier.capabilities) {
        for (const cell of cap.roles) {
          if (!cell.registered) continue; // an unregistered role has no principal to grant to
          total += 1;
          if (cell.granted) granted += 1;
        }
      }
    }
    return { granted, total };
  }, [detail]);

  const registeredRoles = detail?.roles.filter((r) => r.registered).length ?? 0;
  const unregisteredRoles = (detail?.roles.length ?? 0) - registeredRoles;

  function cellKey(capId: string, roleName: string) {
    return `${capId}:${roleName}`;
  }

  // Replace one cell in place, leaving every other row untouched. The grant id a create returns is
  // what a later revoke needs, so it is threaded straight back into the cell rather than triggering
  // a full reload — the reload would flatten every optimistic edit made since.
  function patchCell(capId: string, roleName: string, next: Partial<IntegrationGrantCell>) {
    setDetail((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        tiers: prev.tiers.map((tier) => ({
          ...tier,
          capabilities: tier.capabilities.map((cap) =>
            cap.id !== capId
              ? cap
              : {
                  ...cap,
                  roles: cap.roles.map((cell) =>
                    cell.roleName === roleName ? { ...cell, ...next } : cell,
                  ),
                },
          ),
        })),
      };
    });
  }

  async function apply(cap: IntegrationDetailCapability, cell: IntegrationGrantCell, grant: boolean) {
    if (!cell.principalId) return; // guarded: the toggle is disabled for an unregistered role
    const key = cellKey(cap.id, cell.roleName);
    setPending((p) => new Set(p).add(key));
    try {
      if (grant) {
        const created = await policy.grants.create({
          principalId: cell.principalId,
          capabilityId: cap.id,
          reason: `granted from the ${id} integration view`,
        });
        patchCell(cap.id, cell.roleName, { grantId: created.id, granted: true });
      } else if (cell.grantId) {
        await policy.grants.revoke(cell.grantId, `revoked from the ${id} integration view`);
        patchCell(cap.id, cell.roleName, { grantId: null, granted: false });
      }
    } catch (err) {
      // Central refuses some writes (a destructive auto-grant, a stale grant) with a message that
      // says why — surfaced as it came back rather than restated, so the two can never disagree.
      showToast(err instanceof ApiError ? err.message : "Could not change the grant.", "error");
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(key);
        return next;
      });
    }
  }

  function onToggle(cap: IntegrationDetailCapability, cell: IntegrationGrantCell, next: boolean) {
    // A destructive capability going ON gets a confirm first — the same guard the per-principal
    // Grants page uses, for the same reason: one flip lets an agent take irreversible action on
    // every node in the fleet.
    if (next && cap.riskTier === "destructive") {
      setDestructiveGrant({ cap, cell });
      return;
    }
    apply(cap, cell, next);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{detail?.label ?? id}</h1>
          <p>
            Every capability this {detail?.kind === "provider" ? "provider" : "integration"} owns,
            and which roles hold each one. A toggle here grants or revokes exactly that pair on
            central and it replicates to every node on the next poll.{" "}
            <Link to="/fleet/integrations">Back to providers &amp; integrations</Link>.
          </p>
        </div>
        <LiveControl auto={auto} onRefresh={reload} />
      </div>

      {error && (
        <div className="error-banner">
          Could not load this integration: {error}
          {/* The detail route is authority-only — a per-role grant matrix has no meaning until
              central holds the policy tables — so in shadow mode this is the 409 the reader sees. */}
        </div>
      )}
      {loading && <div className="loading">Loading this integration…</div>}

      {detail && (
        <>
          <div className="stat-grid">
            <StatTile
              label={detail.kind === "provider" ? "Provider" : "Integration"}
              value={detail.enabled ? "Enabled" : "Disabled"}
              sub={detail.enabled ? "granted fleet-wide" : "off fleet-wide"}
            />
            <StatTile
              label="Capabilities owned"
              value={count(detail.capabilityCount)}
              sub={detail.owners.length ? `owner ${detail.owners.join(", ")}` : "no capability owner"}
            />
            <StatTile
              label="Grants held"
              value={`${totals.granted} / ${totals.total}`}
              sub="capability × role pairs granted"
            />
            <StatTile
              label="Target roles"
              value={count(registeredRoles)}
              sub={
                unregisteredRoles === 0
                  ? "all registered fleet-wide"
                  : `${unregisteredRoles} not yet registered`
              }
            />
          </div>

          <div className="card">
            <div className="provider-row-detail">
              <span className="muted">Description</span>
              <span>{detail.description}</span>
            </div>
            <div className="provider-row-detail">
              <span className="muted">Manage as a whole</span>
              <span className="muted">
                Enable, sync its default grants or revoke them all on the{" "}
                <Link to="/fleet/integrations">Providers &amp; integrations</Link> page. This view is
                for changing one grant at a time.
              </span>
            </div>
          </div>

          {detail.tiers.length === 0 ? (
            <div className="card empty-state">
              {detail.owners.length === 0
                ? "This provider owns no capabilities of its own — it contributes its roles' default grants through the integrations they enable, which you manage on those integrations' pages."
                : "No capability in the catalog is owned by this integration yet. They appear here once a node discovers and reports them."}
            </div>
          ) : (
            detail.tiers.map((tier) => (
              <TierTable
                key={tier.tier}
                tier={tier}
                pending={pending}
                cellKey={cellKey}
                onToggle={onToggle}
              />
            ))
          )}
        </>
      )}

      {destructiveGrant && (
        <ConfirmDialog
          title="Grant a destructive capability"
          message={`"${destructiveGrant.cap.name}" is tier-destructive${
            destructiveGrant.cap.description ? ` (${destructiveGrant.cap.description})` : ""
          }. Granting it to ${destructiveGrant.cell.roleName} lets every running instance of that role take irreversible action on every node in the fleet. Continue?`}
          confirmLabel="Grant anyway"
          danger
          onCancel={() => setDestructiveGrant(null)}
          onConfirm={() => {
            const target = destructiveGrant;
            setDestructiveGrant(null);
            apply(target.cap, target.cell, true);
          }}
        />
      )}
    </div>
  );
}

/**
 * One tier's capabilities as a matrix — capabilities down the side, the tier's target roles across
 * the top. The role columns come from the tier itself (every capability in it targets the same set),
 * so an unregistered role is one greyed column rather than a note repeated on every row.
 */
function TierTable({
  tier,
  pending,
  cellKey,
  onToggle,
}: {
  tier: IntegrationDetailTier;
  pending: Set<string>;
  cellKey: (capId: string, roleName: string) => string;
  onToggle: (cap: IntegrationDetailCapability, cell: IntegrationGrantCell, next: boolean) => void;
}) {
  // Column order from the first capability — within a tier the role set is identical, so this is the
  // whole set; falling back to a union keeps it honest if that ever stops being true.
  const roleColumns = useMemo(() => {
    const seen = new Map<string, boolean>();
    for (const cap of tier.capabilities) {
      for (const cell of cap.roles) if (!seen.has(cell.roleName)) seen.set(cell.roleName, cell.registered);
    }
    return [...seen.entries()].map(([roleName, registered]) => ({ roleName, registered }));
  }, [tier]);

  const grantedPairs = tier.capabilities.reduce(
    (sum, cap) => sum + cap.roles.filter((c) => c.registered && c.granted).length,
    0,
  );
  const totalPairs = tier.capabilities.reduce(
    (sum, cap) => sum + cap.roles.filter((c) => c.registered).length,
    0,
  );

  const modeNote =
    tier.policyMode === "auto"
      ? "auto-granted by default"
      : tier.policyMode === "explicit"
        ? "a curated default include-list"
        : "granted to nobody by default";

  return (
    <div className="card">
      <div className="tier-group">
        <h3>
          <TierBadge tier={tier.tier} /> {TIER_LABEL[tier.tier]}
          <span className="muted" style={{ fontWeight: 400 }}>
            {" "}
            ({grantedPairs}/{totalPairs} granted · {modeNote})
          </span>
        </h3>
        <table className="cap-table">
          <thead>
            <tr>
              <th>Capability</th>
              {roleColumns.map((col) => (
                <th key={col.roleName} className="tabular" style={{ textAlign: "center" }}>
                  {col.roleName}
                  {!col.registered && (
                    <div className="muted" style={{ fontWeight: 400 }} title="No node has registered this role fleet-wide yet, so there is no principal to grant to.">
                      not registered
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tier.capabilities.map((cap) => {
              const cellByRole = new Map(cap.roles.map((c) => [c.roleName, c]));
              return (
                <tr key={cap.id}>
                  <td>
                    <div className="name">
                      {cap.name}
                      {!cap.included && (
                        <span
                          className="kind-pill"
                          style={{ marginLeft: 8 }}
                          title="The package's default policy does not grant this on Sync — you can still grant it by hand here."
                        >
                          not a default
                        </span>
                      )}
                    </div>
                    <code className="muted" title={cap.description ?? undefined}>
                      {cap.id}
                    </code>
                  </td>
                  {roleColumns.map((col) => {
                    const cell = cellByRole.get(col.roleName);
                    if (!cell) return <td key={col.roleName} className="muted" style={{ textAlign: "center" }}>—</td>;
                    const key = cellKey(cap.id, col.roleName);
                    return (
                      <td key={col.roleName} style={{ textAlign: "center" }}>
                        <Toggle
                          checked={cell.granted}
                          disabled={!cell.registered || pending.has(key)}
                          label={
                            !cell.registered
                              ? `${col.roleName} is not registered fleet-wide — nothing to grant to.`
                              : `${cell.granted ? "Revoke" : "Grant"} ${cap.name} for ${col.roleName}`
                          }
                          onChange={(next) => onToggle(cap, cell, next)}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
