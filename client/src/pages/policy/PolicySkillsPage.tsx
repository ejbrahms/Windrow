import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/client";
import { policy } from "../../api/policy";
import type { PolicySkill } from "../../api/policy";
import { useFetch } from "../../api/useFetch";
import { StatTile } from "../../components/StatTile";
import { Toggle } from "../../components/Toggle";
import { count, list } from "../fleet/shared";
import { useToast } from "../../components/Toast";
import { NameWithId, TierBadge, when } from "./shared";

/**
 * THE FLEET SKILL LIBRARY — `GET /api/policy/skills`, `PATCH /api/policy/capabilities/:id/distribute`.
 *
 * Skills are catalog-only for ENFORCEMENT: there is no PreToolUse choke point to gate a skill, so no
 * grant is ever issued against one (docs/design/skill-mcp-governance.md §0) — which is why they are
 * absent from the Grants page and show "n/a" for auto-grant on the Catalog. This page is the OTHER
 * half of what a central skill catalog is for: PROVISIONING. Mark a skill "distribute" and every
 * node's installer (server/skillDistribution.js) writes its SKILL.md into that machine's skill
 * directories on its next poll, so a user on any node just has the skill without hunting for it.
 *
 * The distribute flag rides its own channel — GET /api/policy/skills, reconciled in full each poll —
 * NOT the version-bearing policy delta the grants/capabilities replicate through, because
 * provisioning is a separate axis from the enforcement policy the hot path reads.
 */
export function PolicySkillsPage() {
  const { data, loading, error, reload } = useFetch(() => policy.skills.list(), []);
  const [rows, setRows] = useState<PolicySkill[] | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const { showToast } = useToast();

  useEffect(() => setRows(data ? data.skills : null), [data]);

  const skills = useMemo(() => list(rows), [rows]);
  const distributedCount = skills.filter((s) => s.distribute).length;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        (s.owner ?? "").toLowerCase().includes(needle) ||
        (s.description ?? "").toLowerCase().includes(needle)
    );
  }, [skills, search]);

  function setDistribute(skill: PolicySkill, next: boolean) {
    setPending((p) => new Set(p).add(skill.id));
    policy.skills
      .setDistribute(skill.id, next)
      .then((updated) => setRows((prev) => (prev ?? []).map((s) => (s.id === skill.id ? updated : s))))
      .catch((err: unknown) => showToast(err instanceof ApiError ? err.message : String(err), "error"))
      .finally(() =>
        setPending((p) => {
          const copy = new Set(p);
          copy.delete(skill.id);
          return copy;
        })
      );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Skills</h1>
          <p>
            The fleet's skill library. Skills aren't gated at call time — there's no hook to enforce
            one — so they carry no grants. What this page does instead is <strong>distribute</strong>{" "}
            them: mark a skill for the fleet and every node installs its <code>SKILL.md</code> on its
            next poll, so anyone on any machine has it without hunting for it.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load skills: {error}</div>}

      <div className="stat-grid">
        <StatTile label="Skills" value={count(skills.length)} sub="in the fleet catalog" />
        <StatTile label="Distributed" value={count(distributedCount)} sub="auto-installed on every node" />
        <StatTile label="Not distributed" value={count(skills.length - distributedCount)} sub="catalogued only" />
      </div>

      <div className="card">
        <div className="filters">
          <label>
            Search
            <input
              type="search"
              value={search}
              placeholder="name, owner or description"
              onChange={(e) => setSearch(e.target.value)}
              style={{ minWidth: 260 }}
            />
          </label>
          <span className="muted" style={{ marginLeft: "auto", alignSelf: "center" }}>
            {filtered.length} of {skills.length} shown
          </span>
        </div>

        {loading && <div className="loading">Loading skills…</div>}
        {!loading && filtered.length === 0 && !error && (
          <div className="empty-state">
            {skills.length === 0 ? "No skills in the catalog yet." : "No skill matches this search."}
          </div>
        )}
        {!loading && filtered.length > 0 && (
          <table className="cap-table">
            <colgroup>
              <col style={{ width: "22%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "39%" }} />
              <col style={{ width: "16%" }} />
            </colgroup>
            <thead>
              <tr>
                <th>Skill</th>
                <th>Owner</th>
                <th>Risk</th>
                <th>What it does</th>
                <th>Distribute to fleet</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td>
                    <NameWithId name={s.name} id={s.id} />
                    <div className="muted" style={{ fontSize: 11 }}>added {when(s.createdAt)}</div>
                  </td>
                  <td className="muted">{s.owner ?? "—"}</td>
                  <td>
                    <TierBadge tier={s.riskTier} />
                  </td>
                  <td className="muted desc" title={s.description ?? undefined}>
                    {s.description ?? "—"}
                  </td>
                  <td>
                    <Toggle
                      checked={s.distribute}
                      disabled={pending.has(s.id)}
                      label={`${s.distribute ? "Stop distributing" : "Distribute"} ${s.name} to every node`}
                      onChange={(next) => setDistribute(s, next)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ fontSize: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          A distributed skill's <code>SKILL.md</code> is written from its name and description into
          each node's writable skill directories. A node installs missing skills and removes ones it
          previously installed that are no longer distributed; a skill a user added by hand is never
          touched. Changes land on a node within its skill-sync interval (default 60s).{" "}
          <button
            type="button"
            className="btn"
            style={{ padding: "2px 8px", fontSize: 12 }}
            onClick={reload}
          >
            Refresh
          </button>
        </p>
      </div>
    </div>
  );
}
