import { useState } from "react";
import { api, ApiError } from "../api/client";
import { useFetch } from "../api/useFetch";
import type { PackageStatus, ProviderStatus } from "../api/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ProviderIcon } from "../components/ProviderIcon";

/**
 * Discover/install the PreToolUse/PostToolUse hook wiring for each backend adapter
 * (server/providers.js, server/hooks/*.js) — the piece `hookInstallPaths` (server/config.js) was
 * named for but that, until now, only got written by hand-editing `.claude/settings.json` /
 * `.agents/hooks.json`. "Installed" here means the hook commands are actually present in that
 * backend's own config file, not just that the hook scripts exist on disk.
 *
 * Each provider row also carries its capability package (docs/design/capability-packages.md,
 * server/packages.js): what that backend grants by default once it's wired up. Installing hooks
 * and enabling the package are one action from here — POST /api/providers/:id/install enables and
 * syncs the matching package server-side — so there's no separate "did I remember to also flip the
 * package on" step; uninstalling disables it the same way. Integrations (below) are a separate
 * decision, since not every workspace uses every one.
 */
export function ProvidersPage() {
  const providersFetch = useFetch(() => api.providers.list(), []);
  const packagesFetch = useFetch(() => api.packages.list(), []);

  const [pending, setPending] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ProviderStatus | null>(null);
  const [lastSync, setLastSync] = useState<Record<string, string>>({});

  function withPending<T>(id: string, fn: () => Promise<T>, onDone?: (result: T) => void) {
    setActionError(null);
    setPending((p) => new Set(p).add(id));
    fn()
      .then((result) => {
        onDone?.(result);
        providersFetch.reload();
        packagesFetch.reload();
      })
      .catch((err) => setActionError(err instanceof ApiError ? err.message : "Request failed."))
      .finally(() =>
        setPending((p) => {
          const next = new Set(p);
          next.delete(id);
          return next;
        }),
      );
  }

  const providers = providersFetch.data ?? [];
  const allPackages = packagesFetch.data ?? [];
  const packageById = new Map(allPackages.map((pkg) => [pkg.id, pkg]));
  const integrationPackages = allPackages.filter((p) => p.kind === "integration");

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Providers &amp; Integrations</h1>
          <p>
            A provider needs its hooks installed to be governed at all, so installing them also
            enables and syncs its default-grant package — one decision, not two. Integrations are a
            separate opt-in, since not every workspace uses every one. Either way, read-only
            capabilities in an enabled package auto-grant and self-heal as new ones are discovered;
            mutating and destructive ones stay a curated list — <strong>Sync</strong> applies
            whatever the current policy says is missing, any time you want to re-check.
          </p>
        </div>
      </div>

      {providersFetch.error && <div className="error-banner">Could not load providers: {providersFetch.error}</div>}
      {packagesFetch.error && <div className="error-banner">Could not load packages: {packagesFetch.error}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      <h2 className="section-heading">Providers</h2>
      <p className="muted section-subhead">
        Installing hooks enables and syncs that backend's default-grant package in the same step;
        uninstalling disables it. <strong>Sync</strong> here just re-checks coverage without
        touching the hook wiring — useful after a new capability shows up for a backend you've
        already installed.
      </p>
      {(providersFetch.loading || packagesFetch.loading) && <div className="loading">Loading providers…</div>}
      {!providersFetch.loading && !packagesFetch.loading && (
        <div className="provider-list">
          {providers.map((p) => {
            const isPending = pending.has(p.id);
            const pkg = packageById.get(p.id);
            const fullyCovered = !!pkg && pkg.coverage.total > 0 && pkg.coverage.granted >= pkg.coverage.total;
            return (
              <div key={p.id} className="card provider-row">
                <div className="provider-row-title">
                  <ProviderIcon icon={p.icon} label={p.label} />
                  <h2>{p.label}</h2>
                  <span className={`badge ${p.installed ? "badge-ok" : "badge-denied"}`}>
                    {p.installed ? "Hooks installed" : "Not installed"}
                  </span>
                </div>

                <div className="provider-row-detail">
                  <span className="muted">Config file</span>
                  {p.configPath ? (
                    <code>{p.configPath}</code>
                  ) : (
                    <span className="muted">No known hook-install location yet</span>
                  )}
                  {p.configPath && !p.configExists && (
                    <span className="muted">Doesn't exist yet — installing will create it.</span>
                  )}
                </div>

                <div className="provider-row-detail">
                  <span className="muted">Hook scripts</span>
                  <span className="provider-row-hooks">
                    {p.hookFiles.map((f) => (
                      <code key={f}>{f}</code>
                    ))}
                  </span>
                </div>

                {pkg && (
                  <div className="provider-row-detail">
                    <span className="muted">Default-grant package</span>
                    {pkg.coverage.total > 0 ? (
                      <span
                        className={fullyCovered ? undefined : "badge badge-mutating"}
                        style={fullyCovered ? undefined : { display: "inline-block", width: "fit-content" }}
                      >
                        {pkg.enabled ? "Enabled" : "Disabled"} · {pkg.coverage.granted} / {pkg.coverage.total} granted
                      </span>
                    ) : (
                      <span className="muted">{pkg.enabled ? "Enabled" : "Disabled"} · no capabilities owned directly</span>
                    )}
                    {lastSync[p.id] && <span className="muted">{lastSync[p.id]}</span>}
                  </div>
                )}

                <div className="actions">
                  {pkg && pkg.enabled && (
                    <button
                      className="btn"
                      disabled={isPending}
                      onClick={() =>
                        withPending(p.id, () => api.packages.sync(pkg.id), (result) =>
                          setLastSync((m) => ({
                            ...m,
                            [p.id]: `Granted ${result.sync?.granted ?? 0}, ${result.sync?.alreadyPresent ?? 0} already present.`,
                          })),
                        )
                      }
                    >
                      {isPending ? "Syncing…" : "Sync"}
                    </button>
                  )}
                  {!p.installable ? (
                    <span className="muted">Not installable yet</span>
                  ) : p.installed ? (
                    <button
                      className="btn btn-danger"
                      disabled={isPending}
                      onClick={() => setConfirmTarget(p)}
                    >
                      {isPending ? "Working…" : "Uninstall hooks"}
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary"
                      disabled={isPending}
                      onClick={() => withPending(p.id, () => api.providers.install(p.id))}
                    >
                      {isPending ? "Installing…" : "Install hooks"}
                    </button>
                  )}
                </div>

                {p.error && <div className="error-banner provider-row-error">{p.error}</div>}
              </div>
            );
          })}
        </div>
      )}

      <h2 className="section-heading">Integration packages</h2>
      <p className="muted section-subhead">
        One package per MCP tool family or skill catalog. Not every workspace uses every
        integration — leave one off and its capabilities stay visible in the catalog but ungranted.
      </p>
      {packagesFetch.loading && <div className="loading">Loading packages…</div>}
      {!packagesFetch.loading && (
        <div className="provider-list">
          {integrationPackages.map((pkg) => (
            <PackageRow
              key={pkg.id}
              pkg={pkg}
              isPending={pending.has(pkg.id)}
              lastSync={lastSync[pkg.id]}
              onToggle={() =>
                withPending(pkg.id, () => (pkg.enabled ? api.packages.disable(pkg.id) : api.packages.enable(pkg.id)))
              }
              onSync={() =>
                withPending(pkg.id, () => api.packages.sync(pkg.id), (result) =>
                  setLastSync((m) => ({
                    ...m,
                    [pkg.id]: `Granted ${result.sync?.granted ?? 0}, ${result.sync?.alreadyPresent ?? 0} already present.`,
                  })),
                )
              }
            />
          ))}
        </div>
      )}

      {confirmTarget && (
        <ConfirmDialog
          title="Uninstall hooks"
          message={`Remove the capability-governance PreToolUse/PostToolUse entries from ${confirmTarget.label}'s config? Tool calls from that backend will go ungoverned until reinstalled.`}
          confirmLabel="Uninstall"
          danger
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => {
            const target = confirmTarget;
            setConfirmTarget(null);
            withPending(target.id, () => api.providers.uninstall(target.id));
          }}
        />
      )}
    </div>
  );
}

function PackageRow({
  pkg,
  isPending,
  lastSync,
  onToggle,
  onSync,
}: {
  pkg: PackageStatus;
  isPending: boolean;
  lastSync?: string;
  onToggle: () => void;
  onSync: () => void;
}) {
  const fullyCovered = pkg.coverage.total > 0 && pkg.coverage.granted >= pkg.coverage.total;
  return (
    <div className="card provider-row">
      <div className="provider-row-title">
        <h2>{pkg.label}</h2>
        <span className={`badge ${pkg.enabled ? "badge-ok" : "badge-denied"}`}>
          {pkg.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      <div className="provider-row-detail">
        <span className="muted">Description</span>
        <span>{pkg.description}</span>
      </div>

      <div className="provider-row-detail">
        <span className="muted">Default-grant coverage</span>
        {pkg.coverage.total > 0 ? (
          <span className={fullyCovered ? undefined : "badge badge-mutating"} style={fullyCovered ? undefined : { display: "inline-block", width: "fit-content" }}>
            {pkg.coverage.granted} / {pkg.coverage.total} granted
          </span>
        ) : (
          <span className="muted">No capabilities owned directly</span>
        )}
        {lastSync && <span className="muted">{lastSync}</span>}
      </div>

      <div className="actions">
        <button className="btn" disabled={isPending} onClick={onToggle}>
          {isPending ? "Working…" : pkg.enabled ? "Disable" : "Enable"}
        </button>
        <button className="btn btn-primary" disabled={isPending || !pkg.enabled} onClick={onSync}>
          {isPending ? "Syncing…" : "Sync"}
        </button>
      </div>
    </div>
  );
}
