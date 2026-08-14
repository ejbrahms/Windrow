import { useState } from "react";
import { api, ApiError } from "../api/client";
import { useFetch } from "../api/useFetch";
import type { ProviderStatus } from "../api/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ProviderIcon } from "../components/ProviderIcon";

/**
 * Discover/install the PreToolUse/PostToolUse hook wiring for each backend adapter
 * (server/providers.js, server/hooks/*.js) — the piece `hookInstallPaths` (server/config.js) was
 * named for but that, until now, only got written by hand-editing `.claude/settings.json` /
 * `.agents/hooks.json`. "Installed" here means the hook commands are actually present in that
 * backend's own config file, not just that the hook scripts exist on disk.
 */
export function ProvidersPage() {
  const { data, loading, error, reload } = useFetch(() => api.providers.list(), []);

  const [pending, setPending] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ProviderStatus | null>(null);

  function withPending(id: string, fn: () => Promise<unknown>) {
    setActionError(null);
    setPending((p) => new Set(p).add(id));
    fn()
      .then(() => reload())
      .catch((err) => setActionError(err instanceof ApiError ? err.message : "Request failed."))
      .finally(() =>
        setPending((p) => {
          const next = new Set(p);
          next.delete(id);
          return next;
        }),
      );
  }

  const providers = data ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Providers</h1>
          <p>
            Discover which agent providers this field can enforce governance against, and wire up
            the PreToolUse/PostToolUse hooks each one needs with a single click. Uninstall removes
            just the capability-governance entries — everything else already in that backend's
            config file (permissions, other hook groups) is left alone.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load providers: {error}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      {loading && <div className="loading">Loading providers…</div>}

      {!loading && (
        <div className="provider-grid">
          {providers.map((p) => {
            const isPending = pending.has(p.id);
            return (
              <div key={p.id} className="card provider-card">
                <div className="provider-card-header">
                  <div className="provider-card-title">
                    <ProviderIcon icon={p.icon} label={p.label} />
                    <h2>{p.label}</h2>
                  </div>
                  <span className={`badge ${p.installed ? "badge-ok" : "badge-denied"}`}>
                    {p.installed ? "Hooks installed" : "Not installed"}
                  </span>
                </div>

                <div className="provider-detail">
                  <span className="muted">Config file</span>
                  {p.configPath ? (
                    <code>{p.configPath}</code>
                  ) : (
                    <span className="muted">No known hook-install location yet</span>
                  )}
                </div>
                {p.configPath && !p.configExists && (
                  <div className="provider-detail muted">Doesn't exist yet — installing will create it.</div>
                )}
                {p.error && <div className="error-banner">{p.error}</div>}

                <div className="provider-detail">
                  <span className="muted">Hook scripts</span>
                  <ul className="provider-hook-list">
                    {p.hookFiles.map((f) => (
                      <li key={f}>
                        <code>{f}</code>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="actions">
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
              </div>
            );
          })}
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
