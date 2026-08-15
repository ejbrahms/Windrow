import { useMemo } from "react";
import { api } from "../api/client";
import { useFetch } from "../api/useFetch";
import { groupPrincipalsByDisplayName } from "../api/principal";
import type { Principal } from "../api/types";

export function PrincipalsPage() {
  const { data, loading, error } = useFetch(() => api.principals.list(), []);

  const { roles, instancesByRole } = useMemo(() => {
    const roles: Principal[] = (data ?? []).filter((p) => p.kind === "role");
    const instancesByRole = new Map<string, Principal[]>();
    for (const p of data ?? []) {
      if (p.kind !== "instance") continue;
      const key = p.parentRole ?? "(no parent role)";
      if (!instancesByRole.has(key)) instancesByRole.set(key, []);
      instancesByRole.get(key)!.push(p);
    }
    return { roles, instancesByRole };
  }, [data]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Principals</h1>
          <p>
            Agent roles (default grants) and specific instances — real running agents (agent id,
            human name, backend, workspace), instance-level overrides on top of their role.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load principals: {error}</div>}
      {loading && <div className="loading">Loading principals…</div>}

      {!loading && roles.length === 0 && !error && (
        <div className="empty-state">No principals registered yet.</div>
      )}

      {!loading &&
        roles.map((role) => {
          const instances = instancesByRole.get(role.name) ?? [];
          // A human respawned into several agent ids (a new session, a restart) otherwise gets one
          // row per agent here, repeating the same human name down the "Human" column — group so
          // each human appears once per role, with every agent of theirs listed on that one row.
          const groups = groupPrincipalsByDisplayName(instances);
          return (
            <div className="card" key={role.id}>
              <h2>
                {role.name} <span className="muted">role</span>
              </h2>
              {groups.length === 0 ? (
                <div className="muted" style={{ fontSize: 13 }}>
                  No instances currently overriding this role.
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Human</th>
                      <th>Backend</th>
                      <th>Parent role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => (
                      <tr key={group.instances[0].id}>
                        <td>{group.instances[0].humanName ?? <span className="muted">—</span>}</td>
                        <td className="muted">
                          {Array.from(new Set(group.instances.map((i) => i.backend ?? "—"))).join(", ")}
                        </td>
                        <td className="muted">{group.instances[0].parentRole}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
    </div>
  );
}
