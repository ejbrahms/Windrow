import { useState } from "react";
import { api, ApiError } from "../api/client";
import { useFetch } from "../api/useFetch";
import type { DiscoverySourceEntry } from "../api/types";
import { Toggle } from "../components/Toggle";
import { ConfirmDialog } from "../components/ConfirmDialog";

/**
 * Manual configuration for discovery's filesystem scan roots (server/discovery/scan.js), backed
 * by server/store.js's discovery_sources table. Complements the "Run discovery" button on the
 * Catalog page: this is *where* discovery looks, that's *when* it runs.
 */
export function SourcesPage() {
  const { data, loading, error, reload } = useFetch(() => api.discovery.sources.list(), []);

  const [newPath, setNewPath] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<DiscoverySourceEntry | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");

  function withPending<T>(id: string, fn: () => Promise<T>): Promise<T> {
    setPending((p) => new Set(p).add(id));
    return fn().finally(() =>
      setPending((p) => {
        const next = new Set(p);
        next.delete(id);
        return next;
      }),
    );
  }

  async function addSource() {
    const path = newPath.trim();
    if (!path) return;
    setAdding(true);
    setAddError(null);
    try {
      await api.discovery.sources.create({ path, label: newLabel.trim() || null });
      setNewPath("");
      setNewLabel("");
      reload();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Failed to add source.");
    } finally {
      setAdding(false);
    }
  }

  async function toggleEnabled(source: DiscoverySourceEntry, enabled: boolean) {
    setActionError(null);
    try {
      await withPending(source.id, () => api.discovery.sources.update(source.id, { enabled }));
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to update source.");
    }
  }

  async function saveLabel(source: DiscoverySourceEntry) {
    setActionError(null);
    try {
      await withPending(source.id, () =>
        api.discovery.sources.update(source.id, { label: editLabel.trim() || null }),
      );
      setEditingId(null);
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to update source.");
    }
  }

  async function removeSource(source: DiscoverySourceEntry) {
    setActionError(null);
    try {
      await withPending(source.id, () => api.discovery.sources.remove(source.id));
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Failed to remove source.");
    }
  }

  const sources = data ?? [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Discovery sources</h1>
          <p>
            Filesystem directories discovery scans for SKILL.md files (server/discovery/scan.js). Add a
            directory, disable one without losing it, or remove it — the next "Run discovery" on the
            Catalog page picks up the change.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load sources: {error}</div>}
      {addError && <div className="error-banner">{addError}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      <div className="card">
        <h2>Add a source</h2>
        <div className="filters">
          <label style={{ flex: "2 1 260px" }}>
            Path
            <input
              type="text"
              placeholder={"C:\\path\\to\\skills"}
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addSource();
              }}
            />
          </label>
          <label style={{ flex: "1 1 160px" }}>
            Label (optional)
            <input
              type="text"
              placeholder="e.g. team skills share"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addSource();
              }}
            />
          </label>
          <button className="btn btn-primary" onClick={addSource} disabled={adding || !newPath.trim()}>
            {adding ? "Adding…" : "Add source"}
          </button>
        </div>
      </div>

      <div className="card">
        {loading && <div className="loading">Loading sources…</div>}
        {!loading && sources.length === 0 && !error && (
          <div className="empty-state">No discovery sources configured.</div>
        )}
        {!loading && sources.length > 0 && (
          <table className="cap-table">
            <colgroup>
              <col style={{ width: "40%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "18%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Path</th>
                <th>Label</th>
                <th>Origin</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const isPending = pending.has(s.id);
                return (
                  <tr key={s.id} className={!s.enabled ? "stale-row" : undefined}>
                    <td>
                      <code>{s.path}</code>
                      {!s.exists && <span className="stale-label">MISSING</span>}
                    </td>
                    <td>
                      {editingId === s.id ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <input
                            type="text"
                            value={editLabel}
                            autoFocus
                            onChange={(e) => setEditLabel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveLabel(s);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                          />
                          <button className="btn" style={{ padding: "3px 8px" }} onClick={() => saveLabel(s)}>
                            Save
                          </button>
                        </div>
                      ) : (
                        <span
                          className="muted"
                          style={{ cursor: "pointer" }}
                          title="Click to edit label"
                          onClick={() => {
                            setEditingId(s.id);
                            setEditLabel(s.label ?? "");
                          }}
                        >
                          {s.label ?? "—"}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="kind-pill">{s.builtIn ? "default" : "manual"}</span>
                    </td>
                    <td>
                      <Toggle
                        checked={s.enabled}
                        disabled={isPending}
                        label={`${s.enabled ? "Disable" : "Enable"} source ${s.path}`}
                        onChange={(next) => toggleEnabled(s, next)}
                      />
                    </td>
                    <td>
                      <button
                        className="btn btn-danger"
                        style={{ padding: "3px 10px", fontSize: 12 }}
                        disabled={isPending}
                        onClick={() => setConfirmTarget(s)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {confirmTarget && (
        <ConfirmDialog
          title="Remove discovery source"
          message={`Remove "${confirmTarget.path}" from discovery's scan roots? Capabilities already registered from it stay in the catalog until they go stale.`}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => {
            const target = confirmTarget;
            setConfirmTarget(null);
            removeSource(target);
          }}
        />
      )}
    </div>
  );
}
