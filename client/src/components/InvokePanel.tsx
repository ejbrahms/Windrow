import { useState } from "react";
import { api, ApiError } from "../api/client";
import type { Capability, InvokeResult, Principal } from "../api/types";
import { principalDisplayName } from "../api/principal";
import { OutcomeBadge } from "./Badge";

interface InvokePanelProps {
  principals: Principal[];
  capabilities: Capability[];
  onInvoked?: () => void;
}

/** Lets a human fire a real /api/invoke call and watch the broker allow/deny it live. */
export function InvokePanel({ principals, capabilities, onInvoked }: InvokePanelProps) {
  const [principalId, setPrincipalId] = useState("");
  const [capabilityId, setCapabilityId] = useState("");
  const [result, setResult] = useState<InvokeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleInvoke() {
    if (!principalId || !capabilityId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.invoke({ principalId, capabilityId });
      setResult(res);
      onInvoked?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invoke failed.");
    } finally {
      setBusy(false);
    }
  }

  const principalName = principalDisplayName(principals.find((p) => p.id === principalId));
  const capabilityName = capabilities.find((c) => c.id === capabilityId)?.name;

  return (
    <div className="card">
      <h2>Invoke demo</h2>
      <p className="muted" style={{ marginTop: -6, fontSize: 12 }}>
        Calls the real broker endpoint so you can watch a grant get enforced.
      </p>
      <div className="invoke-form">
        <label>
          Principal
          <select value={principalId} onChange={(e) => setPrincipalId(e.target.value)}>
            <option value="">Select a principal…</option>
            {principals.map((p) => (
              <option key={p.id} value={p.id}>
                {principalDisplayName(p)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Capability
          <select value={capabilityId} onChange={(e) => setCapabilityId(e.target.value)}>
            <option value="">Select a capability…</option>
            {capabilities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" disabled={!principalId || !capabilityId || busy} onClick={handleInvoke}>
          {busy ? "Invoking…" : "Invoke"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {result && (
        <div className={`invoke-result ${result.allowed ? "allowed" : "denied"}`}>
          <OutcomeBadge outcome={result.event.outcome} />
          <span>
            {principalName || result.event.principalId} → {capabilityName ?? result.event.capabilityId}:{" "}
            {result.allowed ? "call executed" : "blocked, no active grant"} ({result.event.latencyMs}ms)
          </span>
        </div>
      )}
    </div>
  );
}
