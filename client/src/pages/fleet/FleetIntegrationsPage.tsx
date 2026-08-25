import { useState } from "react";
import { Link } from "react-router-dom";
import { fleet } from "../../api/fleet";
import type { FleetIntegration, IntegrationNodeState } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { ApiError } from "../../api/client";
import { StatTile } from "../../components/StatTile";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { LiveControl } from "../../components/LiveControl";
import { useAutoRefresh } from "../../hooks/useAutoRefresh";
import { count, when, shortId } from "./shared";
import { useToast } from "../../components/Toast";

/**
 * FLEET PROVIDERS & INTEGRATIONS — the fleet-wide half of the node's Providers & Integrations page.
 * It answers two questions the node page cannot, because a node only knows about itself:
 *
 *   - what is each package SET TO for the whole fleet, and turn it on or off here (server
 *     /central/packages.js → grants that replicate on the delta stream).
 *   - which BOXES actually run it right now (queries.integrationAdoption, off the machine-facts
 *     each node ships up). A node whose local toggle disagrees with the fleet decision is drift,
 *     drawn as such rather than reconciled away — the node is authoritative for its own tier.
 *
 * BOTH FAMILIES, IN THEIR OWN SECTIONS. A `provider` package bundles a backend adapter's default
 * grants; an `integration` an MCP tool family or skill catalog (see IntegrationKind in
 * ../../api/fleet). Fleet-wide the two are managed identically — enable/disable/sync/revoke all act
 * on grants by package id, whatever the kind — so one card draws either. The hook-install wiring a
 * provider also needs is node-local and stays on the node's Providers page; here a provider is its
 * fleet-wide grant decision and its per-node adoption, nothing more.
 *
 * WRITES NEED AUTHORITY. Enabling a package is issuing grants, and grants only live centrally
 * once central holds the policy tables. In shadow mode the read still answers (adoption needs no
 * policy tables) and the controls are disabled with a line saying why — the same honesty the nav
 * uses when it refuses to offer a destination that cannot work.
 */
export function FleetIntegrationsPage() {
  const { data, loading, error, reload } = useFetch(() => fleet.integrations(), []);
  const auto = useAutoRefresh({
    storageKey: "fleet-integrations-auto-refresh",
    reload,
    dataSignal: data,
  });

  const [pending, setPending] = useState<Set<string>>(new Set());
  const { showToast } = useToast();
  const [revokeTarget, setRevokeTarget] = useState<FleetIntegration | null>(null);
  const [lastAction, setLastAction] = useState<Record<string, string>>({});

  function withPending<T>(id: string, fn: () => Promise<T>, onDone?: (result: T) => void) {
    setPending((p) => new Set(p).add(id));
    fn()
      .then((result) => {
        onDone?.(result);
        reload();
      })
      .catch((err) => showToast(err instanceof ApiError ? err.message : "Request failed.", "error"))
      .finally(() =>
        setPending((p) => {
          const next = new Set(p);
          next.delete(id);
          return next;
        }),
      );
  }

  const writable = data?.writable ?? false;
  // Both package families are this page's business now, split into their own sections the way the
  // node's Providers page splits them (see ProvidersPage). Providers first: a provider bundles a
  // backend adapter's default grants, and an integration layers a tool family or skill catalog on
  // top — reading the backends before the tools that ride them mirrors that dependency.
  const allPackages = data?.integrations ?? [];
  const providers = allPackages.filter((i) => i.kind === "provider");
  const integrations = allPackages.filter((i) => i.kind === "integration");
  const anyDiverged = allPackages.reduce((sum, i) => sum + i.adoption.diverged, 0);

  // Every card wires the same three writes to `withPending`; the only per-card state is the
  // integration itself, so the handlers are built once here rather than duplicated per section.
  const renderCard = (integration: FleetIntegration) => (
    <IntegrationCard
      key={integration.id}
      integration={integration}
      writable={writable}
      isPending={pending.has(integration.id)}
      lastAction={lastAction[integration.id]}
      onToggle={() =>
        withPending(
          integration.id,
          () =>
            integration.enabled
              ? fleet.disableIntegration(integration.id)
              : fleet.enableIntegration(integration.id),
          (result) => {
            if (result.sync) {
              setLastAction((m) => ({
                ...m,
                [integration.id]: `Enabled — granted ${result.sync!.granted}, ${result.sync!.alreadyPresent} already present.`,
              }));
            } else {
              setLastAction((m) => ({ ...m, [integration.id]: "Disabled — existing grants left in place." }));
            }
          },
        )
      }
      onSync={() =>
        withPending(integration.id, () => fleet.syncIntegration(integration.id), (result) =>
          setLastAction((m) => ({
            ...m,
            [integration.id]: `Synced — granted ${result.sync?.granted ?? 0}, ${result.sync?.alreadyPresent ?? 0} already present.`,
          })),
        )
      }
      onRevoke={() => setRevokeTarget(integration)}
    />
  );

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Providers &amp; Integrations</h1>
          <p>
            What each provider and integration is set to across the whole fleet, and which nodes are
            actually running it. Enabling one here grants its default capabilities on central and they
            replicate to every node on the next poll — one decision, not thirty. The per-node column
            is what each machine last reported for itself; where it disagrees with the fleet setting,
            that is <strong>drift</strong>, shown rather than hidden. Installing a provider's hooks is
            node-local and stays on each machine's own Providers page.
          </p>
        </div>
        <LiveControl auto={auto} onRefresh={reload} />
      </div>

      {error && <div className="error-banner">Could not load providers &amp; integrations: {error}</div>}
      {loading && <div className="loading">Reading fleet providers &amp; integrations…</div>}

      {data && (
        <>
          {!writable && (
            <div className="error-banner">
              Central is in <strong>shadow</strong> mode — the nodes are still the policy writers, so
              a provider or integration cannot be turned on fleet-wide from here yet. This view is
              read-only until central takes authority; the per-node adoption below is live regardless.
            </div>
          )}

          <div className="stat-grid">
            <StatTile
              label="Providers"
              value={count(providers.length)}
              sub={`${providers.filter((p) => p.enabled).length} enabled fleet-wide`}
            />
            <StatTile
              label="Integrations"
              value={count(integrations.length)}
              sub={`${integrations.filter((i) => i.enabled).length} enabled fleet-wide`}
            />
            <StatTile
              label="Reporting nodes"
              value={count(data.nodes.reporting)}
              sub={
                data.nodes.reporting === 0
                  ? "no node has shipped facts yet"
                  : "boxes whose local state is known"
              }
            />
            <StatTile
              label="Policy mode"
              value={data.mode === "authority" ? "Authority" : "Shadow"}
              sub={
                data.mode === "authority"
                  ? "central owns the grants these produce"
                  : "read-only — nodes are the writers"
              }
            />
            <StatTile
              label="Nodes diverging"
              value={count(anyDiverged)}
              sub={
                anyDiverged === 0
                  ? "every node matches its fleet setting"
                  : "local toggle disagrees with the fleet"
              }
            />
          </div>

          <h2 className="section-heading">Providers</h2>
          <p className="muted section-subhead">
            Backend adapters and the default-grant package each brings. Enabling one here grants its
            capabilities fleet-wide; a machine still needs the provider's hooks installed locally to
            be governed at all, which is done on that node's own Providers page.
          </p>
          {providers.length === 0 ? (
            <div className="empty-state">No provider packages are defined.</div>
          ) : (
            <div className="provider-list">{providers.map(renderCard)}</div>
          )}

          <h2 className="section-heading">Integration packages</h2>
          <p className="muted section-subhead">
            One package per MCP tool family or skill catalog. Not every workspace uses every
            integration — leave one off and its capabilities stay in the catalog but ungranted.
          </p>
          {integrations.length === 0 ? (
            <div className="empty-state">No integration packages are defined.</div>
          ) : (
            <div className="provider-list">{integrations.map(renderCard)}</div>
          )}
        </>
      )}

      {revokeTarget && (
        <ConfirmDialog
          title="Revoke grants"
          message={`Delete every grant ${revokeTarget.label}'s roles hold on the capabilities it owns — across the whole fleet, and separate from Disable, which only stops future auto-grants. Agents relying on this access lose it on their next policy poll.`}
          confirmLabel="Revoke"
          danger
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => {
            const target = revokeTarget;
            setRevokeTarget(null);
            withPending(target.id, () => fleet.revokeIntegration(target.id), (result) =>
              setLastAction((m) => ({
                ...m,
                [target.id]: `Revoked ${result.revoke?.revoked ?? 0} grant(s) fleet-wide.`,
              })),
            );
          }}
        />
      )}
    </div>
  );
}

function IntegrationCard({
  integration,
  writable,
  isPending,
  lastAction,
  onToggle,
  onSync,
  onRevoke,
}: {
  integration: FleetIntegration;
  writable: boolean;
  isPending: boolean;
  lastAction?: string;
  onToggle: () => void;
  onSync: () => void;
  onRevoke: () => void;
}) {
  const { adoption, coverage } = integration;
  const fullyCovered = !!coverage && coverage.total > 0 && coverage.granted >= coverage.total;

  return (
    <div className="card provider-row">
      <div className="provider-row-title">
        <h2>{integration.label}</h2>
        <span className={`badge ${integration.enabled ? "badge-ok" : "badge-denied"}`}>
          {integration.enabled ? "Enabled fleet-wide" : "Disabled fleet-wide"}
        </span>
        {adoption.diverged > 0 && (
          <span className="badge badge-error" title="Nodes whose local state disagrees with the fleet setting">
            {adoption.diverged} diverging
          </span>
        )}
      </div>

      <div className="provider-row-detail">
        <span className="muted">Description</span>
        <span>{integration.description}</span>
      </div>

      {coverage ? (
        <div className="provider-row-detail">
          <span className="muted">Default-grant coverage</span>
          {coverage.total > 0 ? (
            <span
              className={fullyCovered ? undefined : "badge badge-mutating"}
              style={fullyCovered ? undefined : { display: "inline-block", width: "fit-content" }}
            >
              {coverage.granted} / {coverage.total} granted
            </span>
          ) : (
            <span className="muted">No capabilities owned directly</span>
          )}
          {lastAction && <span className="muted">{lastAction}</span>}
        </div>
      ) : (
        lastAction && (
          <div className="provider-row-detail">
            <span className="muted">Last action</span>
            <span className="muted">{lastAction}</span>
          </div>
        )
      )}

      <div className="provider-row-detail">
        <span className="muted">On which nodes</span>
        {adoption.reporting === 0 ? (
          <span className="muted">No node has reported its integration state yet.</span>
        ) : (
          <>
            <span>
              {adoption.enabled} of {adoption.reporting} node{adoption.reporting === 1 ? "" : "s"}{" "}
              running it
            </span>
            <div className="badge-row">
              {adoption.nodes.map((node) => (
                <NodeChip key={node.nodeId} node={node} fleetEnabled={integration.enabled} />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="actions">
        {/* The drill-down: this card's Enable/Sync/Revoke act on the whole package, but they cannot
            say WHICH grants are held or change exactly one. That is the detail page — every owned
            capability crossed with the roles it targets, each pair its own toggle. */}
        <Link className="btn" to={`/fleet/integrations/${encodeURIComponent(integration.id)}`}>
          View grants
        </Link>
        <button className="btn" disabled={isPending || !writable} onClick={onToggle}>
          {isPending ? "Working…" : integration.enabled ? "Disable" : "Enable"}
        </button>
        <button
          className="btn btn-primary"
          disabled={isPending || !writable || !integration.enabled}
          onClick={onSync}
        >
          {isPending ? "Syncing…" : "Sync"}
        </button>
        <button className="btn btn-danger" disabled={isPending || !writable} onClick={onRevoke}>
          {isPending ? "Working…" : "Revoke grants"}
        </button>
      </div>
    </div>
  );
}

/** One node's state for this integration. Green when it is running the integration, muted when not;
 *  an asterisk marks a node whose EFFECTIVE state disagrees with the fleet decision — the drift the
 *  page exists to surface. `explicit` (the node set its own toggle) vs default is in the tooltip,
 *  because a node running the default is a weaker claim than one that deliberately chose. */
function NodeChip({ node, fleetEnabled }: { node: IntegrationNodeState; fleetEnabled: boolean }) {
  const diverged = node.enabled !== fleetEnabled;
  const name = node.label || shortId(node.nodeId);
  const title = [
    node.nodeId,
    node.enabled ? "running this integration" : "not running it",
    node.explicit ? "its own toggle" : "the package default",
    node.factsReportedAt ? `reported ${when(node.factsReportedAt)}` : "",
    diverged ? "— disagrees with the fleet setting" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={`badge ${node.enabled ? "badge-ok" : "badge"} ${diverged ? "node-chip-diverged" : ""}`} title={title}>
      {name}
      {diverged && <span aria-hidden="true"> *</span>}
    </span>
  );
}
