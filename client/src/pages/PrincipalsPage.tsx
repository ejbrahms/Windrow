import { useMemo } from "react";
import { api } from "../api/client";
import { useFetch } from "../api/useFetch";
import type { Principal } from "../api/types";
// Shared with the recent-calls table, which shows the tier a *single call* was identified at
// (docs/design/global-identity-and-central-db.md §1.4) — the same three words either way.
import { assuranceLabel } from "../api/assurance";

export function PrincipalsPage() {
  const { data, loading, error } = useFetch(() => api.principals.list(), []);

  const { roles, instancesByRole, subjects } = useMemo(() => {
    const roles: Principal[] = (data ?? []).filter((p) => p.kind === "role");
    // The `user` principals — one per OS account, keyed on `subjectId`
    // (docs/design/global-identity-and-central-db.md §1.4). Recorded from now on and shown here so
    // that "what the registry knows about who is behind these agents" is visible; they hold no
    // grants and authorize nothing yet.
    const subjects: Principal[] = (data ?? []).filter((p) => p.kind === "user");
    const instancesByRole = new Map<string, Principal[]>();
    for (const p of data ?? []) {
      if (p.kind !== "instance") continue;
      const key = p.parentRole ?? "(no parent role)";
      if (!instancesByRole.has(key)) instancesByRole.set(key, []);
      instancesByRole.get(key)!.push(p);
    }
    return { roles, instancesByRole, subjects };
  }, [data]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Principals</h1>
          <p>
            Agent roles (default grants) and specific instances — real running agents, one row
            per agent id, with instance-level overrides on top of their role. The name column is a
            platform-assigned nickname and can repeat across agents; the agent id is the identity.
          </p>
        </div>
      </div>

      {!loading && subjects.length > 0 && (
        <div className="card">
          <h2>
            Subjects <span className="muted">people</span>
          </h2>
          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            The OS account behind the calls, keyed on an authority-prefixed identifier that survives
            respawns, backends and renames. The label is editable and identifies nothing; the subject
            is the key. Grants still attach to roles and agents — these rows are recorded, not yet
            enforced against.
          </div>
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Subject</th>
                <th>Assurance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {subjects.map((subject) => (
                <tr key={subject.id}>
                  <td>{subject.name}</td>
                  <td className="muted"><code>{subject.subjectId}</code></td>
                  {/* 3 server-verified, 2 OS-read on this machine, 1 env-derived. Spelled out
                      rather than shown as a bare number: "1" and "2" look like a ranking, and the
                      difference between them is whether the identity was read from the OS or taken
                      from an environment variable the process being identified could have set. */}
                  <td className="muted">{assuranceLabel(subject.assuranceLevel)}</td>
                  <td className="muted">{subject.status ?? "active"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <div className="error-banner">Could not load principals: {error}</div>}
      {loading && <div className="loading">Loading principals…</div>}

      {!loading && roles.length === 0 && !error && (
        <div className="empty-state">No principals registered yet.</div>
      )}

      {!loading &&
        roles.map((role) => {
          // One row per instance principal, keyed on its id. These used to be grouped by the
          // `humanName` column, which is a nickname the platform assigns from a fixed cast pack,
          // not a person (docs/design/global-identity-and-central-db.md §1.1): two agents that
          // drew the same nickname collapsed into a single row that read as one identity, and one
          // agent respawned under a new id never rejoined its earlier row anyway. Until principals
          // carry a real subject key, the honest view is the agent, so the agent id is shown
          // beside the nickname.
          const instances = instancesByRole.get(role.name) ?? [];
          return (
            <div className="card" key={role.id}>
              <h2>
                {role.name} <span className="muted">role</span>
              </h2>
              {instances.length === 0 ? (
                <div className="muted" style={{ fontSize: 13 }}>
                  No instances currently overriding this role.
                </div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Agent</th>
                      <th>Backend</th>
                      <th>Parent role</th>
                      {/* Who this agent belongs to, once a human has confirmed it on the
                          dashboard (docs/design/global-identity-and-central-db.md §1.6). Read-only
                          here: the proposal and the evidence behind it live where the decision is
                          made, and a column that could be edited without them would be a guess
                          accepted blind. */}
                      <th>Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instances.map((instance) => (
                      <tr key={instance.id}>
                        <td>{instance.humanName ?? <span className="muted">—</span>}</td>
                        <td className="muted"><code>{instance.name}</code></td>
                        <td className="muted">{instance.backend ?? "—"}</td>
                        <td className="muted">{instance.parentRole}</td>
                        <td className={instance.ownerStatus === "confirmed" ? undefined : "muted"}>
                          {instance.ownerStatus === "confirmed" ? (
                            instance.ownerOsUser
                          ) : instance.ownerStatus === "dismissed" ? (
                            "no owner"
                          ) : (
                            "unassigned"
                          )}
                        </td>
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
