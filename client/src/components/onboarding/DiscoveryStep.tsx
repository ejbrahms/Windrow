import { useState } from "react";
import { api } from "../../api/client";
import type { DiscoveryResult } from "../../api/types";

/**
 * First scan, right after sources are configured — same call as the Catalog page's "Run
 * discovery" button, just surfaced here so the catalog isn't empty the first time it's opened.
 */
export function DiscoveryStep() {
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function runDiscovery() {
    setRunning(true);
    setError(null);
    api.discovery
      .run()
      .then(setResult)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRunning(false));
  }

  return (
    <div className="onboarding-step">
      <h2>Run your first scan</h2>
      <p>
        Scan the sources you just configured (plus the MCP tool manifest) and register whatever
        they find as capabilities. Safe to re-run any time — a scan only adds, updates, or stales
        entries, it never deletes.
      </p>

      {error && <div className="error-banner">Discovery run failed: {error}</div>}

      <button className="btn btn-primary" onClick={runDiscovery} disabled={running}>
        {running ? "Scanning…" : result ? "Run again" : "Run discovery"}
      </button>

      {result && (
        <div className="discovery-summary" style={{ marginTop: 14 }}>
          <span className="stat">
            <strong>{result.added.length}</strong> added
          </span>
          <span className="stat">
            <strong>{result.updated.length}</strong> updated
          </span>
          <span className="stat">
            <strong>{result.staled.length}</strong> newly stale
          </span>
        </div>
      )}
      {!result && !running && (
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          You can also skip this and run it later from the Catalog page.
        </p>
      )}
    </div>
  );
}
