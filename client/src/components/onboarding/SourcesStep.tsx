import { useState } from "react";
import { api, ApiError } from "../../api/client";
import { useFetch } from "../../api/useFetch";
import type { DiscoverySourceEntry } from "../../api/types";

/**
 * Condensed add/remove flow for discovery's scan roots — same calls as SourcesPage, without the
 * label-editing or confirm dialog (there's nothing destructive-enough here to warrant one before
 * a first scan has even run).
 */
export function SourcesStep() {
  const { data, loading, error, reload } = useFetch(() => api.discovery.sources.list(), []);
  const [newPath, setNewPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());

  async function addSource() {
    const path = newPath.trim();
    if (!path) return;
    setAdding(true);
    setAddError(null);
    try {
      await api.discovery.sources.create({ path, label: null });
      setNewPath("");
      reload();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Failed to add source.");
    } finally {
      setAdding(false);
    }
  }

  async function removeSource(source: DiscoverySourceEntry) {
    setPending((p) => new Set(p).add(source.id));
    try {
      await api.discovery.sources.remove(source.id);
      reload();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Failed to remove source.");
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(source.id);
        return next;
      });
    }
  }

  const sources = data ?? [];

  return (
    <div className="onboarding-step">
      <h2>Add discovery sources</h2>
      <p>
        Discovery scans these filesystem directories for SKILL.md files and registers what it
        finds in the catalog. A couple of defaults may already be seeded — add any of your own,
        or skip and come back from the Sources page later.
      </p>

      {error && <div className="error-banner">Could not load sources: {error}</div>}
      {addError && <div className="error-banner">{addError}</div>}

      <div className="filters" style={{ marginBottom: 12 }}>
        <input
          type="text"
          placeholder={"C:\\path\\to\\skills"}
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addSource();
          }}
          style={{ flex: "1 1 auto" }}
        />
        <button className="btn btn-primary" onClick={addSource} disabled={adding || !newPath.trim()}>
          {adding ? "Adding…" : "Add"}
        </button>
      </div>

      {loading && <div className="loading">Loading sources…</div>}
      {!loading && sources.length === 0 && !error && (
        <div className="empty-state">No discovery sources configured yet.</div>
      )}
      {!loading && sources.length > 0 && (
        <ul className="onboarding-source-list">
          {sources.map((s) => (
            <li key={s.id}>
              <code>{s.path}</code>
              {!s.exists && <span className="stale-label">MISSING</span>}
              <button
                className="btn btn-danger"
                style={{ padding: "3px 10px", fontSize: 12 }}
                disabled={pending.has(s.id)}
                onClick={() => removeSource(s)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
