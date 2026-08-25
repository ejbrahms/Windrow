import { useState } from "react";
import { api, ApiError } from "../api/client";
import { useFetch } from "../api/useFetch";
import type { Capability, SkillTargetPresence } from "../api/types";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";

/**
 * Central skills management: skills are catalog-only, not governed (docs/design/
 * skill-mcp-governance.md §0 — no grants, no usage tracking against them), so this page is the
 * counterpart to Grants/Catalog for the other half of the capability table. "Add a skill" writes
 * a SKILL.md into every selected provider's skill directory in one shot instead of an admin
 * hand-authoring one per provider; "Manage" shows which providers currently have it and lets you
 * remove it from some or all of them.
 */
export function SkillsPage() {
  const { data: capabilities, loading, error, reload } = useFetch(() => api.capabilities.list(), []);
  const { data: targets, loading: loadingTargets } = useFetch(() => api.skills.targets(), []);
  const skillCaps = (capabilities ?? []).filter((c) => c.kind === "skill");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addResult, setAddResult] = useState<string | null>(null);

  const [manageTarget, setManageTarget] = useState<Capability | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Capability | null>(null);
  const [presence, setPresence] = useState<SkillTargetPresence[] | null>(null);
  const [presenceLoading, setPresenceLoading] = useState(false);
  const { showToast } = useToast();
  const [pendingRemoveIds, setPendingRemoveIds] = useState<Set<string>>(new Set());
  const [pendingAddIds, setPendingAddIds] = useState<Set<string>>(new Set());

  function toggleTarget(id: string) {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addSkill() {
    const trimmed = name.trim();
    if (!trimmed || selectedTargets.size === 0) return;
    setAdding(true);
    setAddError(null);
    setAddResult(null);
    try {
      const result = await api.skills.create({
        name: trimmed,
        description: description.trim() || undefined,
        targetIds: Array.from(selectedTargets),
      });
      setAddResult(`Wrote "${trimmed}" to ${result.written.length} provider${result.written.length === 1 ? "" : "s"}.`);
      setName("");
      setDescription("");
      setSelectedTargets(new Set());
      reload();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Failed to create skill.");
    } finally {
      setAdding(false);
    }
  }

  async function openManage(cap: Capability) {
    setManageTarget(cap);
    setPresence(null);
    setPresenceLoading(true);
    try {
      const p = await api.skills.presence(cap.name);
      setPresence(p);
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to load presence.", "error");
    } finally {
      setPresenceLoading(false);
    }
  }

  async function removeFromTarget(cap: Capability, targetId: string) {
    setPendingRemoveIds((p) => new Set(p).add(targetId));
    try {
      await api.skills.remove(cap.name, [targetId]);
      const p = await api.skills.presence(cap.name);
      setPresence(p);
      reload();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to remove skill from that provider.", "error");
    } finally {
      setPendingRemoveIds((p) => {
        const next = new Set(p);
        next.delete(targetId);
        return next;
      });
    }
  }

  // Adds an already-catalogued skill to one more provider — same write path as the "Add a skill"
  // form above (POST /api/skills is idempotent-ish per target: it just (re)writes SKILL.md), just
  // pre-filled from the capability already selected in Manage instead of a blank form.
  async function addToTarget(cap: Capability, targetId: string) {
    setPendingAddIds((p) => new Set(p).add(targetId));
    try {
      await api.skills.create({
        name: cap.name,
        description: cap.description || undefined,
        targetIds: [targetId],
      });
      const p = await api.skills.presence(cap.name);
      setPresence(p);
      reload();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to add skill to that provider.", "error");
    } finally {
      setPendingAddIds((p) => {
        const next = new Set(p);
        next.delete(targetId);
        return next;
      });
    }
  }

  async function removeEverywhere(cap: Capability) {
    try {
      await api.skills.remove(cap.name);
      setRemoveTarget(null);
      setManageTarget(null);
      reload();
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Failed to remove skill.", "error");
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Skills</h1>
          <p>
            Skills aren't governed like MCP tools — no grants, no usage tracking (see{" "}
            <a href="#/docs">docs</a> for why). This is a central place to add a skill across every
            provider's skill directory at once, and see which providers already have it.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load skills: {error}</div>}
      {addError && <div className="error-banner">{addError}</div>}
      {addResult && <div className="card" style={{ padding: "8px 14px", fontSize: 13 }}>{addResult}</div>}

      <div className="card">
        <h2>Add a skill</h2>
        <div className="filters" style={{ alignItems: "flex-start" }}>
          <label style={{ flex: "1 1 200px" }}>
            Name
            <input
              type="text"
              placeholder="e.g. release-checklist"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label style={{ flex: "2 1 320px" }}>
            Description
            <input
              type="text"
              placeholder="One line — what it's for and when to use it"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Write to which providers?
          </div>
          {loadingTargets && <div className="loading">Loading providers…</div>}
          {!loadingTargets && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {(targets ?? []).map((t) => (
                <label key={t.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={selectedTargets.has(t.id)}
                    onChange={() => toggleTarget(t.id)}
                  />
                  <span>{t.label}</span>
                  {!t.exists && <span className="muted" style={{ fontSize: 11 }}>(will be created)</span>}
                </label>
              ))}
            </div>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <button
            className="btn btn-primary"
            onClick={addSkill}
            disabled={adding || !name.trim() || selectedTargets.size === 0}
          >
            {adding ? "Adding…" : "Add skill"}
          </button>
        </div>
      </div>

      <div className="card">
        {loading && <div className="loading">Loading skills…</div>}
        {!loading && skillCaps.length === 0 && !error && (
          <div className="empty-state">No skills in the catalog yet.</div>
        )}
        {!loading && skillCaps.length > 0 && (
          <table className="cap-table">
            <colgroup>
              <col style={{ width: "22%" }} />
              <col style={{ width: "48%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "14%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Owner</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {skillCaps.map((c) => (
                <tr key={c.id} className={c.stale ? "stale-row" : undefined}>
                  <td>
                    <strong>{c.name}</strong>
                    {c.stale && <span className="stale-label">STALE</span>}
                  </td>
                  <td className="muted">{c.description}</td>
                  <td className="muted">{c.owner}</td>
                  <td>
                    <button className="btn" style={{ padding: "3px 10px", fontSize: 12 }} onClick={() => openManage(c)}>
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {manageTarget && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setManageTarget(null)}>
          <div
            className="dialog dialog-wide"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 style={{ marginTop: 0 }}>{manageTarget.name}</h2>
            <p className="muted" style={{ fontSize: 13 }}>{manageTarget.description}</p>
            {presenceLoading && <div className="loading">Checking providers…</div>}
            {!presenceLoading && presence && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                {presence.map((p) => (
                  <div key={p.id} className="grant-row">
                    <div className="info">
                      <div className="name">{p.label}</div>
                      <div className="desc muted">{p.path}</div>
                    </div>
                    {p.present ? (
                      <button
                        className="btn btn-danger"
                        style={{ padding: "3px 10px", fontSize: 12 }}
                        disabled={pendingRemoveIds.has(p.id)}
                        onClick={() => removeFromTarget(manageTarget, p.id)}
                      >
                        {pendingRemoveIds.has(p.id) ? "Removing…" : "Remove"}
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary"
                        style={{ padding: "3px 10px", fontSize: 12 }}
                        disabled={pendingAddIds.has(p.id)}
                        onClick={() => addToTarget(manageTarget, p.id)}
                      >
                        {pendingAddIds.has(p.id) ? "Adding…" : "Add"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 16, display: "flex", justifyContent: "space-between" }}>
              <button className="btn btn-danger" onClick={() => setRemoveTarget(manageTarget)}>
                Remove everywhere
              </button>
              <button className="btn" onClick={() => setManageTarget(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {removeTarget && (
        <ConfirmDialog
          title="Remove skill everywhere"
          message={`Delete "${removeTarget.name}"'s SKILL.md from every provider that has it? This can't be undone from here.`}
          confirmLabel="Remove everywhere"
          danger
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => removeEverywhere(removeTarget)}
        />
      )}
    </div>
  );
}
