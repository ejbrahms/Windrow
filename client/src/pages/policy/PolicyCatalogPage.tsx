import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "../../api/client";
import { activeGrants, policy, RISK_TIERS } from "../../api/policy";
import type { PolicyCapability, PolicyRiskTier } from "../../api/policy";
import { useFetch } from "../../api/useFetch";
import { StatTile } from "../../components/StatTile";
import { Toggle } from "../../components/Toggle";
import { count, list } from "../fleet/shared";
import {
  CapabilityFilterBar,
  KindPill,
  NameWithId,
  TIER_LABEL,
  TIER_ORDER,
  TierBadge,
  capabilityLabel,
  useCapabilityFilters,
  when,
} from "./shared";

/**
 * THE FLEET'S CAPABILITY CATALOG — `GET/POST /api/policy/capabilities`.
 *
 * The canonical list, and the word canonical is the whole of item 2 of §2.2: a capability row is
 * minted HERE and its id is the one every node agrees on. Before central was the authority each
 * machine minted its own, so two laptops that discovered the same MCP tool held two rows with two
 * ids, and a grant issued against one was invisible to the other — a registry that agreed on
 * vocabulary and nothing else.
 *
 * MOST ROWS HERE WERE NOT TYPED BY A HUMAN. A node reports what it found on its disk and central
 * answers with the canonical row (`POST /api/policy/capabilities/resolve`), landing it at
 * `read_only` with no description. The registration form below is the other door — the one where
 * an admin states the tier up front — and it is the smaller of the two by a long way.
 *
 * RE-RUNNING DISCOVERY NEVER RE-TIERS ANYTHING. `resolveCapability` only ever creates; a row's
 * risk tier is a decision, and a decision that a filesystem scan could overwrite would not be one.
 * So the tier column on this page is the only place that judgement is recorded, and the auto-grant
 * switch beside it is the only control that changes what it means.
 */
export function PolicyCatalogPage() {
  const { data, loading, error, reload } = useFetch(() => policy.capabilities.list(), []);
  // Every live grant, for one column: how many principals actually hold this capability. It is the
  // question the catalog cannot answer about itself, and the one that turns "139 capabilities"
  // into "139 capabilities, 47 of which anybody can use".
  const { data: grantRows } = useFetch(() => policy.grants.list(), []);

  const [rows, setRows] = useState<PolicyCapability[] | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => setRows(data), [data]);

  const capabilities = useMemo(() => list(rows), [rows]);
  const filters = useCapabilityFilters(capabilities);

  const holdersByCapability = useMemo(() => {
    const map = new Map<string, number>();
    for (const g of activeGrants(grantRows)) map.set(g.capabilityId, (map.get(g.capabilityId) ?? 0) + 1);
    return map;
  }, [grantRows]);

  const tierCounts = useMemo(() => {
    const map = new Map<PolicyRiskTier, number>(RISK_TIERS.map((t) => [t, 0]));
    for (const c of capabilities) map.set(c.riskTier, (map.get(c.riskTier) ?? 0) + 1);
    return map;
  }, [capabilities]);

  const autoGrantCount = capabilities.filter((c) => c.autoGrant).length;
  const ungranted = capabilities.filter((c) => !c.autoGrant && !holdersByCapability.has(c.id)).length;

  async function setAutoGrant(capability: PolicyCapability, next: boolean) {
    setActionError(null);
    setPending((p) => new Set(p).add(capability.id));
    try {
      const updated = await policy.capabilities.setAutoGrant(capability.id, next);
      setRows((prev) => (prev ?? []).map((c) => (c.id === capability.id ? updated : c)));
    } catch (err) {
      // Central refuses auto-grant on a destructive row with a 400 whose message says so — shown
      // as it came back rather than restated here, so the two can never disagree.
      setActionError(err instanceof ApiError ? err.message : "Could not change auto-grant.");
    } finally {
      setPending((p) => {
        const next2 = new Set(p);
        next2.delete(capability.id);
        return next2;
      });
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Capability catalog</h1>
          <p>
            Every capability the fleet knows about, with the id central minted for it. Nodes report
            what they find on disk and central answers with the canonical row, so re-running
            discovery adds rows and never re-tiers one — the risk tier below is a decision somebody
            made, and this is where it is recorded.
          </p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load the catalog: {error}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      <div className="stat-grid">
        <StatTile label="Capabilities" value={count(capabilities.length)} sub={`${filters.kinds.length} kinds`} />
        {TIER_ORDER.map((tier) => (
          <StatTile key={tier} label={TIER_LABEL[tier]} value={count(tierCounts.get(tier) ?? 0)} />
        ))}
        <StatTile
          label="Auto-granted"
          value={count(autoGrantCount)}
          sub="bypass the grant table entirely"
        />
        <StatTile label="Granted to nobody" value={count(ungranted)} sub="no live grant on any node" />
      </div>

      <RegisterCapability onRegistered={reload} />

      <div className="card">
        <CapabilityFilterBar
          state={filters}
          countLabel={`${filters.filtered.length} of ${capabilities.length} shown`}
        />

        {loading && <div className="loading">Loading the catalog…</div>}
        {!loading && filters.filtered.length === 0 && (
          <div className="empty-state">No capability matches these filters.</div>
        )}
        {!loading && filters.filtered.length > 0 && (
          <table className="cap-table">
            <thead>
              <tr>
                <th>Capability</th>
                <th>Kind</th>
                <th>Owner</th>
                <th>Risk</th>
                <th>Auto-grant</th>
                <th>Granted to</th>
                <th>Registered</th>
                {/* Last, not stacked under the name. A description is the widest thing in the row
                    and the name is the thing being looked for; sharing one cell squeezes the name
                    into two or three characters a line. */}
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {filters.filtered.map((c) => {
                const holders = holdersByCapability.get(c.id) ?? 0;
                return (
                  <tr key={c.id}>
                    <td>
                      <NameWithId name={capabilityLabel(c)} id={c.id} />
                    </td>
                    <td>
                      <KindPill kind={c.kind} />
                    </td>
                    <td className="muted">{c.owner ?? "—"}</td>
                    <td>
                      <TierBadge tier={c.riskTier} />
                    </td>
                    <td>
                      {c.riskTier === "destructive" ? (
                        <span className="muted" title="Central refuses auto-grant on a destructive capability.">
                          never
                        </span>
                      ) : (
                        <Toggle
                          checked={c.autoGrant}
                          disabled={pending.has(c.id)}
                          label={`${c.autoGrant ? "Stop auto-granting" : "Auto-grant"} ${capabilityLabel(c)} to every principal`}
                          onChange={(next) => setAutoGrant(c, next)}
                        />
                      )}
                    </td>
                    <td className="tabular">
                      {c.autoGrant ? (
                        <span className="muted" title="Auto-granted capabilities bypass the grant table.">
                          everyone
                        </span>
                      ) : holders === 0 ? (
                        <span className="muted">nobody</span>
                      ) : (
                        `${holders} principal${holders === 1 ? "" : "s"}`
                      )}
                    </td>
                    <td className="muted">{when(c.createdAt)}</td>
                    <td className="muted desc" title={c.description ?? undefined}>
                      {c.description ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * The admin door into the catalog — `POST /api/policy/capabilities`, which unlike a node's
 * discovery report states the tier up front.
 *
 * Shut by default. Registration is the rare path (four rows in a hundred and thirty-nine were
 * typed rather than discovered), and a form left open above the list would put the least-used
 * control at the top of the most-read page.
 */
function RegisterCapability({ onRegistered }: { onRegistered: () => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("mcp_tool");
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [riskTier, setRiskTier] = useState<PolicyRiskTier>("read_only");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PolicyCapability | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const capability = await policy.capabilities.create({
        kind: kind.trim() || null,
        name: name.trim(),
        owner: owner.trim() || null,
        riskTier,
        description: description.trim() || null,
        reason: "registered from the central dashboard",
      });
      setCreated(capability);
      setName("");
      setOwner("");
      setDescription("");
      onRegistered();
    } catch (err) {
      // 409 is the fleet-wide uniqueness on (kind, name) — worth reading as "it already exists
      // somewhere in the fleet" rather than as a failure, which is what the server's message says.
      setError(err instanceof ApiError ? err.message : "Could not register the capability.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="card">
        <div className="grant-summary">
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Register a capability
          </button>
          <span className="muted">
            For something no node will discover on its own. A node's own discovery lands at
            read-only with no description; this is where a tier is stated up front.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>
        Register a capability <span className="muted">central mints the id</span>
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
          Kind
          <input value={kind} onChange={(e) => setKind(e.target.value)} placeholder="mcp_tool" />
        </label>
        <label>
          Name
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="slack/post"
            style={{ minWidth: 200 }}
          />
        </label>
        <label>
          Owner
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="platform" />
        </label>
        <label>
          Risk tier
          <select value={riskTier} onChange={(e) => setRiskTier(e.target.value as PolicyRiskTier)}>
            {TIER_ORDER.map((t) => (
              <option key={t} value={t}>
                {TIER_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Description
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="what it does"
            style={{ minWidth: 240 }}
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
