import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";

interface DirectoryPickerDialogProps {
  /** Starting point — usually whatever's already typed into the Path field. */
  initialPath?: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

/**
 * Server-side directory browser for the Sources page's "Browse…" button. A source's Path is a
 * path on the *server's* filesystem (the same machine discovery scans), so a browser-native file
 * picker can't fill it in — browsers never hand back an absolute path. This walks
 * server/app.js's GET /api/discovery/browse one level at a time instead.
 */
export function DirectoryPickerDialog({ initialPath, onSelect, onCancel }: DirectoryPickerDialogProps) {
  const [path, setPath] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load(target?: string) {
    setLoading(true);
    setError(null);
    api.discovery
      .browse(target)
      .then((result) => {
        setPath(result.path);
        setParent(result.parent);
        setEntries(result.entries);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Failed to browse.");
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(initialPath || undefined);
    // Only ever navigate from the initial path once, on mount — subsequent moves go through load().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dir-picker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="dir-picker-title">Choose a directory</h3>
        <div className="dir-picker-path">{path || "This computer"}</div>
        {error && <div className="error-banner">{error}</div>}
        <div className="dir-picker-list">
          {loading && <div className="loading">Loading…</div>}
          {!loading && !error && parent !== null && (
            <button className="dir-picker-entry dir-picker-up" onClick={() => load(parent)}>
              .. (up)
            </button>
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="empty-state">No subdirectories.</div>
          )}
          {!loading &&
            !error &&
            entries.map((entry) => (
              <button key={entry.path} className="dir-picker-entry" onClick={() => load(entry.path)}>
                {entry.name}
              </button>
            ))}
        </div>
        <div className="actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!path}
            onClick={() => path && onSelect(path)}
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}
