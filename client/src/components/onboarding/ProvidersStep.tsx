import { useState } from "react";
import { api, ApiError } from "../../api/client";
import { useFetch } from "../../api/useFetch";
import { ProviderIcon } from "../ProviderIcon";

/**
 * Condensed version of ProvidersPage's install flow for the onboarding wizard — same
 * install/uninstall calls, no confirm dialog on uninstall (a first-run wizard step is a lower-
 * stakes place to change your mind than the standalone Providers page).
 */
export function ProvidersStep() {
  const { data, loading, error, reload } = useFetch(() => api.providers.list(), []);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

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
  const installedCount = providers.filter((p) => p.installed).length;

  return (
    <div className="onboarding-step">
      <h2>Connect a provider</h2>
      <p>
        Install the governance hooks into at least one agent backend so it actually enforces the
        grants you set up later. You can install more, or come back and change this any time from
        the Providers page.
      </p>

      {error && <div className="error-banner">Could not load providers: {error}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}
      {loading && <div className="loading">Loading providers…</div>}

      {!loading && (
        <div className="onboarding-provider-list">
          {providers.map((p) => {
            const isPending = pending.has(p.id);
            return (
              <div key={p.id} className="onboarding-provider-row">
                <div className="onboarding-provider-row-info">
                  <ProviderIcon icon={p.icon} label={p.label} />
                  <div>
                    <div className="onboarding-provider-row-name">{p.label}</div>
                    {!p.installable && <span className="muted" style={{ fontSize: 11 }}>Not installable yet</span>}
                    {p.installable && p.configPath && !p.configExists && (
                      <span className="muted" style={{ fontSize: 11 }}>Will create {p.configPath}</span>
                    )}
                  </div>
                </div>
                {p.installable ? (
                  p.installed ? (
                    <button
                      className="btn"
                      disabled={isPending}
                      onClick={() => withPending(p.id, () => api.providers.uninstall(p.id))}
                    >
                      {isPending ? "Working…" : "Installed ✓"}
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary"
                      disabled={isPending}
                      onClick={() => withPending(p.id, () => api.providers.install(p.id))}
                    >
                      {isPending ? "Installing…" : "Install"}
                    </button>
                  )
                ) : (
                  <span className="badge badge-denied">Unavailable</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && providers.length > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          {installedCount === 0
            ? "No providers installed yet — you can skip this and do it later, but nothing will be enforced until at least one is."
            : `${installedCount} of ${providers.length} providers installed.`}
        </p>
      )}
    </div>
  );
}
