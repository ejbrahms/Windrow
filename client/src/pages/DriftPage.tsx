import { api } from "../api/client";
import { useFetch } from "../api/useFetch";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * Grants that have stopped earning their keep, and capabilities being denied at a high rate.
 *
 * Under Security rather than on the Overview because both halves are findings to act on — an
 * idle grant is standing access nobody needs, a high denial rate is either a missing grant or an
 * agent reaching for something it shouldn't. Neither is a number you watch tick.
 */
export function DriftPage() {
  const { data: drift, loading, error } = useFetch(() => api.drift(), []);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Drift</h1>
          <p>Unused grants and high-denial capabilities — where the current access has drifted from what agents actually do.</p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load drift report: {error}</div>}
      {loading && <div className="loading">Loading drift report…</div>}

      {drift && (
        <div className="dashboard-grid">
          <div className="card">
            <h2>
              Unused grants <span className="muted">&gt;90d idle ({drift.unusedGrants.length})</span>
            </h2>
            {drift.unusedGrants.length === 0 ? (
              <div className="empty-state">No grant has been idle for more than 90 days.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Principal</th>
                    <th>Capability</th>
                    <th>Granted</th>
                    <th>Last used</th>
                  </tr>
                </thead>
                <tbody>
                  {drift.unusedGrants.map((g) => (
                    <tr key={g.grantId}>
                      <td>{g.principalName}</td>
                      <td>{g.capabilityName}</td>
                      <td className="muted">{new Date(g.grantedAt).toLocaleDateString()}</td>
                      <td className="muted">
                        {g.lastUsedAt === g.grantedAt ? "never" : new Date(g.lastUsedAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card">
            <h2>
              High-denial capabilities <span className="muted">({drift.highDenial.length})</span>
            </h2>
            {drift.highDenial.length === 0 ? (
              <div className="empty-state">No capability is being denied at a high rate.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Capability</th>
                    <th>Denial rate</th>
                    <th>Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {drift.highDenial.map((c) => (
                    <tr key={c.capabilityId}>
                      <td>{c.name}</td>
                      <td>
                        <span className="badge badge-denied">{pct(c.denialRate)}</span>
                      </td>
                      <td className="muted tabular">{c.calls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
