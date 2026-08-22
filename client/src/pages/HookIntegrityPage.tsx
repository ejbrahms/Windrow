import { api } from "../api/client";
import { useFetch } from "../api/useFetch";
import { EnforcementPauseCard } from "../components/EnforcementPauseCard";

/**
 * server/hookWatcher.js polls each installed backend's own hook-config file and puts the
 * PreToolUse/PostToolUse entries back if they go missing. Every time that happens is logged
 * here — a hand-edit, a compromised skill, or an uninstall script from something else can
 * all cause it, so an entry marked "restore failed" means governance is currently bypassed
 * for that backend. Split out from the Providers page (server/providers.js, server/hooks/*.js)
 * since it's a monitoring/audit view rather than a configuration action.
 */
export function HookIntegrityPage() {
  const providersFetch = useFetch(() => api.providers.list(), []);
  const hookIntegrityFetch = useFetch(() => api.hookIntegrity.get(), []);

  const providers = providersFetch.data ?? [];
  const providerLabelById = new Map(providers.map((p) => [p.id, p.label]));
  const hookIntegrityLog = hookIntegrityFetch.data?.log ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Hook integrity</h1>
          <p>
            Every time a backend's hook wiring is found missing and restored, it's logged here — a
            hand-edit, a compromised skill, or an uninstall script from something else can all
            cause it, so an entry marked "restore failed" means governance is currently bypassed
            for that backend.
          </p>
        </div>
      </div>

      {/* The other side of the same question this page asks. The log below says whether governance
          is still wired up; this says whether it is deliberately switched off right now. Placed
          above the log because it is the actionable half — the log is a record, this is a control. */}
      <EnforcementPauseCard />

      {hookIntegrityFetch.error && (
        <div className="error-banner">Could not load hook integrity log: {hookIntegrityFetch.error}</div>
      )}
      {hookIntegrityFetch.loading && <div className="loading">Loading hook integrity log…</div>}
      {!hookIntegrityFetch.loading && !hookIntegrityFetch.error && (
        hookIntegrityLog.length === 0 ? (
          <div className="empty-state">No tampering detected — every installed backend's hook wiring has stayed intact.</div>
        ) : (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Provider</th>
                  <th>Config file</th>
                  <th>Reason</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {hookIntegrityLog.map((entry, i) => (
                  <tr key={`${entry.ts}-${entry.provider}-${i}`}>
                    <td>{new Date(entry.ts).toLocaleString()}</td>
                    <td>{providerLabelById.get(entry.provider) ?? entry.provider}</td>
                    <td><code>{entry.configPath}</code></td>
                    <td>{entry.reason}</td>
                    <td>
                      <span className={`badge ${entry.repaired ? "badge-ok" : "badge-denied"}`}>
                        {entry.repaired ? "Restored" : "Restore failed"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
