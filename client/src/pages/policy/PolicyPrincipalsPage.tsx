import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "../../api/client";
import { activeGrants, policy } from "../../api/policy";
import type { PolicyPrincipal, PolicyPrincipalStatus } from "../../api/policy";
import { useFetch } from "../../api/useFetch";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { StatTile } from "../../components/StatTile";
import { count, list } from "../fleet/shared";
import { NameWithId, StatusBadge, principalLabel, when } from "./shared";

/**
 * WHO THE FLEET KNOWS — `GET/POST/PATCH /api/policy/principals`.
 *
 * Three kinds of row, and they are not three flavours of the same thing:
 *
 *   PEOPLE (`user`)     keyed on `subjectId`, an opaque OS identifier prefixed by the authority
 *                       that issued it. The *subject* of a call — who it is accountable to.
 *   ROLES (`role`)      the agent kind. The only rows that hold grants an agent inherits.
 *   INSTANCES           one running loom. It inherits its role's grants and holds none of its
 *                       own, which is why there is nothing to grant it and no button to try.
 *
 * STATUS IS NOT A LABEL. `policyDenyList` blocks every principal whose status is not 'active', and
 * that deny-list rides every policy response to every node in full. Denying a role here stops it
 * making a governed call on every machine in the fleet, within one poll — which is exactly what
 * the control is for, and exactly why it asks first.
 *
 * A ROLE'S FIRST SIGHTING LANDS 'pending' WITH ZERO GRANTS rather than being auto-provisioned, so
 * the pending queue at the top of this page is the fleet's front door: an agent type nobody has
 * ruled on yet, seen on some machine, waiting.
 */
export function PolicyPrincipalsPage() {
  const { data, loading, error, reload } = useFetch(() => policy.principals.list(), []);
  const { data: grantRows } = useFetch(() => policy.grants.list(), []);

  const [rows, setRows] = useState<PolicyPrincipal[] | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [denyTarget, setDenyTarget] = useState<PolicyPrincipal | null>(null);

  useEffect(() => setRows(data), [data]);

  const principals = useMemo(() => list(rows), [rows]);

  const grantsByPrincipal = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of activeGrants(grantRows)) map.set(g.principalId, (map.get(g.principalId) ?? 0) + 1);
    return map;
  }, [grantRows]);

  const principalById = useMemo(() => new Map(principals.map((p) => [p.id, p])), [principals]);

  /** `owner` holds a principal id on a row a human confirmed, and can hold a bare OS username on an
   *  older one. Resolved to a name where it names a principal, and left standing as itself where it
   *  does not — the same rule the rest of the control plane uses, and the reason this is not just
   *  `{p.owner}`: an id in an Owner column reads as "unowned by anyone you have heard of". */
  function ownerCell(owner: string | null) {
    if (!owner) return <span className="muted">—</span>;
    const resolved = principalById.get(owner);
    if (!resolved) return <span title={owner}>{owner}</span>;
    return <span title={owner}>{principalLabel(resolved)}</span>;
  }

  const users = useMemo(() => principals.filter((p) => p.kind === "user"), [principals]);
  const roles = useMemo(() => principals.filter((p) => p.kind === "role"), [principals]);
  const instancesByRole = useMemo(() => {
    const map = new Map<string, PolicyPrincipal[]>();
    for (const p of principals) {
      if (p.kind !== "instance") continue;
      const key = p.parentRole ?? "";
      const bucket = map.get(key);
      if (bucket) bucket.push(p);
      else map.set(key, [p]);
    }
    return map;
  }, [principals]);
  // An instance whose parentRole names no row in this list. Not a hypothetical: a role can be
  // renamed, and an instance points at the *name*. Shown rather than silently dropped — an agent
  // nothing on this page accounts for is the one worth seeing.
  const orphanInstances = useMemo(
    () =>
      principals.filter(
        (p) => p.kind === "instance" && !roles.some((r) => r.name === (p.parentRole ?? "")),
      ),
    [principals, roles],
  );
  const pending = useMemo(() => principals.filter((p) => p.status === "pending"), [principals]);

  async function setStatus(principal: PolicyPrincipal, status: PolicyPrincipalStatus) {
    setActionError(null);
    setBusy((b) => new Set(b).add(principal.id));
    try {
      const updated = await policy.principals.update(principal.id, {
        status,
        reason: `set to ${status} from the central dashboard`,
      });
      setRows((prev) => (prev ?? []).map((p) => (p.id === principal.id ? updated : p)));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : `Could not set ${principal.name} to ${status}.`);
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(principal.id);
        return next;
      });
    }
  }

  function StatusControls({ principal }: { principal: PolicyPrincipal }) {
    const isBusy = busy.has(principal.id);
    return (
      <div className="grant-summary" style={{ gap: 8 }}>
        {principal.status !== "active" && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={isBusy}
            onClick={() => setStatus(principal, "active")}
          >
            Activate
          </button>
        )}
        {principal.status !== "denied" && (
          <button type="button" className="btn btn-danger" disabled={isBusy} onClick={() => setDenyTarget(principal)}>
            Deny
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Principals</h1>
          <p>
            Everyone and everything the fleet can attribute a call to, fleet-wide: one row per
            person, per agent role and per running loom, with the id central minted. A principal
            that is not <code>active</code> is on the deny-list every node fetches in full on every
            poll — denying one here stops it on every machine, not just this one.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load principals: {error}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      <div className="stat-grid">
        <StatTile label="People" value={count(users.length)} sub="subjects of a call" />
        <StatTile label="Roles" value={count(roles.length)} sub="hold the grants" />
        <StatTile
          label="Instances"
          value={count(principals.filter((p) => p.kind === "instance").length)}
          sub="inherit their role"
        />
        <StatTile
          label="Denied"
          value={count(principals.filter((p) => p.status === "denied").length)}
          sub="blocked fleet-wide"
        />
      </div>

      {loading && <div className="loading">Loading principals…</div>}

      {pending.length > 0 && (
        <div className="card">
          <h2>
            Waiting on a decision <span className="muted">{pending.length} pending</span>
          </h2>
          <p className="muted">
            Seen for the first time on some machine and provisioned with nothing. Activating lets it
            hold grants; denying leaves it permanently unable to make a governed call anywhere.
          </p>
          {pending.map((p) => (
            <div className="grant-row" key={p.id}>
              <div className="info">
                <div className="name">
                  {principalLabel(p)} <span className="muted">{p.kind}</span>
                </div>
                <div className="desc muted">
                  <code>{p.id}</code>
                  {p.backend ? ` — via ${p.backend}` : ""}
                  {p.parentRole ? ` — under ${p.parentRole}` : ""} — first seen {when(p.createdAt)}
                </div>
              </div>
              <StatusControls principal={p} />
            </div>
          ))}
        </div>
      )}

      <RegisterPrincipal onRegistered={reload} />

      {!loading && users.length > 0 && (
        <div className="card">
          <h2>
            People <span className="muted">the subject of a call</span>
          </h2>
          <p className="muted">
            Keyed on an OS identifier prefixed by the authority that issued it, never on the
            username — which is a display label and can be renamed. A person inherits nothing from a
            role: what they hold on the Grants page is all they can authorise.
          </p>
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Subject key</th>
                <th>Assurance</th>
                <th>Status</th>
                <th>Grants</th>
                <th>Registered</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((p) => (
                <tr key={p.id}>
                  <td>
                    <NameWithId name={principalLabel(p)} id={p.id} />
                  </td>
                  <td className="muted">{p.subjectId ? <code>{p.subjectId}</code> : "—"}</td>
                  <td className="muted tabular">{p.assuranceLevel ?? "—"}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="tabular">{count(grantsByPrincipal.get(p.id) ?? 0)}</td>
                  <td className="muted">{when(p.createdAt)}</td>
                  <td>
                    <StatusControls principal={p} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && roles.length === 0 && users.length === 0 && (
        <div className="card empty-state">No principal has been registered anywhere in the fleet yet.</div>
      )}

      {!loading &&
        roles.map((role) => {
          const instances = instancesByRole.get(role.name) ?? [];
          return (
            <div className="card" key={role.id}>
              <h2>
                {role.name} <span className="muted">role</span> <StatusBadge status={role.status} />
              </h2>
              <div className="grant-summary">
                <code className="muted">{role.id}</code>
                <span className="muted">
                  {count(grantsByPrincipal.get(role.id) ?? 0)} grants — {instances.length} instance
                  {instances.length === 1 ? "" : "s"} — registered {when(role.createdAt)}
                </span>
                <span style={{ marginLeft: "auto" }}>
                  <StatusControls principal={role} />
                </span>
              </div>
              {instances.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>Instance</th>
                      <th>Loom id</th>
                      <th>Backend</th>
                      <th>Workspace</th>
                      <th>Owner</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instances.map((instance) => (
                      <tr key={instance.id}>
                        <td>{instance.humanName ?? <span className="muted">—</span>}</td>
                        <td className="muted">
                          <code title={instance.id}>{instance.name}</code>
                        </td>
                        <td className="muted">{instance.backend ?? "—"}</td>
                        <td className="muted">
                          {instance.standalone ? "standalone" : (instance.field ?? "—")}
                        </td>
                        <td className="muted">{ownerCell(instance.owner)}</td>
                        <td>
                          <StatusBadge status={instance.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}

      {!loading && orphanInstances.length > 0 && (
        <div className="card">
          <h2>
            Instances with no role on this page <span className="muted">{orphanInstances.length}</span>
          </h2>
          <p className="muted">
            Each of these names a <code>parentRole</code> that is not a registered role row, so it
            inherits from nothing and holds nothing. Usually a role that was renamed after the
            instance was minted.
          </p>
          <table>
            <thead>
              <tr>
                <th>Instance</th>
                <th>Loom id</th>
                <th>Names this parent role</th>
                <th>Registered</th>
              </tr>
            </thead>
            <tbody>
              {orphanInstances.map((p) => (
                <tr key={p.id}>
                  <td>{p.humanName ?? <span className="muted">—</span>}</td>
                  <td className="muted">
                    <code title={p.id}>{p.name}</code>
                  </td>
                  <td className="muted">{p.parentRole ? <code>{p.parentRole}</code> : "—"}</td>
                  <td className="muted">{when(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {denyTarget && (
        <ConfirmDialog
          title="Deny a principal fleet-wide"
          message={`"${principalLabel(denyTarget)}" goes on the deny-list every node fetches in full on every poll. Every governed call it makes, on any machine in the fleet, will be refused — its ${
            grantsByPrincipal.get(denyTarget.id) ?? 0
          } grants stay on the books but stop applying. Continue?`}
          confirmLabel="Deny it"
          danger
          onCancel={() => setDenyTarget(null)}
          onConfirm={() => {
            const target = denyTarget;
            setDenyTarget(null);
            setStatus(target, "denied");
          }}
        />
      )}
    </div>
  );
}

/**
 * `POST /api/policy/principals` — and ROLES ONLY, deliberately.
 *
 * Central will accept a `user` row from this route, and a user row typed by hand would be useless:
 * a person is matched on `subjectId`, an OS identifier the hook path reads off the calling machine
 * and prefixes with its authority. There is no way to type one correctly from a browser, and a
 * user row without one can never match a call — it would sit on the Principals page looking like a
 * person who simply never does anything. Instances are excluded for the same kind of reason: they
 * are minted by a loom starting up, not by anyone deciding.
 */
function RegisterPrincipal({ onRegistered }: { onRegistered: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PolicyPrincipal | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const principal = await policy.principals.create({ kind: "role", name: name.trim(), status: "active" });
      setCreated(principal);
      setName("");
      onRegistered();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not register the role.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="card">
        <div className="grant-summary">
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Register a role
          </button>
          <span className="muted">
            For an agent type you want to grant before anything has run under it. People and running
            instances are minted by the machines that see them, not here.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>
        Register a role <span className="muted">unique fleet-wide</span>
      </h2>
      {error && <div className="error-banner">{error}</div>}
      {created && (
        <div className="grant-summary" style={{ marginBottom: 8 }}>
          <span className="muted">Registered</span>
          <code>{created.id}</code>
        </div>
      )}
      <form className="filters" onSubmit={submit}>
        <label>
          Role name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="the agentType a hook will report"
            style={{ minWidth: 280 }}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          {busy ? "Registering…" : "Register"}
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </form>
    </div>
  );
}
