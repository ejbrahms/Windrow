import { useMemo, useState } from "react";
import type { PolicyCapability, PolicyPrincipal, PolicyRiskTier } from "../../api/policy";
import { RISK_TIERS } from "../../api/policy";

/**
 * The pieces all four policy pages share: how a name is drawn beside its id, how a capability and
 * a principal are labelled, and the one filter bar 139 capabilities need to be usable.
 *
 * A SIBLING OF ../fleet/shared.tsx, NOT AN EXTENSION OF IT. That file's helpers are about
 * staleness and size — how old, how many bytes, how far behind. These are about identity: which
 * row is this, and what is it called. Two small files whose subjects differ beats one whose
 * subject is "miscellaneous".
 */

export const TIER_ORDER: PolicyRiskTier[] = [...RISK_TIERS];

export const TIER_LABEL: Record<PolicyRiskTier, string> = {
  read_only: "Read-only",
  mutating: "Mutating",
  destructive: "Destructive",
};

export function TierBadge({ tier }: { tier: PolicyRiskTier }) {
  return <span className={`badge badge-${tier}`}>{TIER_LABEL[tier]}</span>;
}

export function KindPill({ kind }: { kind: string | null }) {
  if (!kind) return <span className="kind-pill">no kind</span>;
  return <span className="kind-pill">{kind === "mcp_tool" ? "MCP tool" : kind}</span>;
}

const STATUS_TONE: Record<string, string> = {
  active: "badge-ok",
  pending: "badge-mutating",
  denied: "badge-denied",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_TONE[status] ?? "badge-error"}`}>{status}</span>;
}

/**
 * A NAME, WITH ITS ID UNDERNEATH — never one instead of the other, and never a blank.
 *
 * The rule is `usageBy` in server/central/queries.js and `FleetUsagePage`, applied to the control
 * plane: the name is what makes a row legible, the id is what makes it actionable, and where
 * nothing resolves the id STANDS ALONE rather than being padded with a placeholder. On this side
 * of the app the third case is not hypothetical — central holds four live grants pointing at a
 * capability id that is not in its catalog, and rendering those as an empty cell would read as
 * "a grant to nothing" when the truth is "a grant to something this catalog cannot name".
 */
export function NameWithId({ name, id }: { name: string | null | undefined; id: string }) {
  if (!name) return <code>{id}</code>;
  return (
    <>
      <div>{name}</div>
      <code className="muted" title={id}>
        {id}
      </code>
    </>
  );
}

/** What a capability is called: `kind/name` where a kind exists, since `slack/post` alone does not
 *  say whether it is a tool or a skill and central's catalog holds both. */
export function capabilityLabel(capability: PolicyCapability | null | undefined): string | null {
  if (!capability) return null;
  return capability.kind ? `${capability.kind}/${capability.name}` : capability.name;
}

/** What a principal is called: the platform nickname an instance carries, else the row's name.
 *  Display only — a nickname is not an identity and must never be a grouping key. The browser-side
 *  twin of ../../api/principal.ts's `principalDisplayName`, retyped for central's own row. */
export function principalLabel(principal: PolicyPrincipal | null | undefined): string | null {
  if (!principal) return null;
  return principal.humanName || principal.name;
}

/** An ISO timestamp, or a Postgres one — central's older rows carry `2026-08-20 00:04:00.31+00`
 *  rather than an ISO string, and `new Date()` on something it cannot parse yields "Invalid Date",
 *  which is a worse answer than the raw value. */
export function when(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

// ---------------------------------------------------------------------------- the filter bar

export interface CapabilityFilterState {
  search: string;
  setSearch: (v: string) => void;
  kind: string;
  setKind: (v: string) => void;
  tier: string;
  setTier: (v: string) => void;
  kinds: string[];
  filtered: PolicyCapability[];
}

/**
 * Search, kind and tier over a capability list.
 *
 * ITS OWN, NOT ../../components/CapabilityFilters. That component filters by *package* as well,
 * which it reads from `GET /api/packages` — a machine-local route central does not mount. Reusing
 * it would give every page here a picker that 404s, which is the exact failure
 * docs/design/dashboard-placement.md item 4 is about.
 *
 * THE KIND LIST IS DERIVED FROM THE DATA rather than hard-coded here. That is deliberate: the
 * Catalog page passes the full capability list (skills included — a skill is catalog-only but is
 * still catalogued) and wants a `skill` option, while the Grants page passes an already-MCP-only
 * list, so its kind picker naturally offers just the one kind. Filtering skills out is the caller's
 * decision (PolicyGrantsPage does it), not this hook's — skills are catalog-only and grant nothing
 * (docs/design/skill-mcp-governance.md §0).
 */
export function useCapabilityFilters(capabilities: PolicyCapability[]): CapabilityFilterState {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const [tier, setTier] = useState("all");

  const kinds = useMemo(() => {
    const seen = new Set<string>();
    for (const c of capabilities) seen.add(c.kind ?? "");
    return [...seen].sort();
  }, [capabilities]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return capabilities.filter((c) => {
      if (kind !== "all" && (c.kind ?? "") !== kind) return false;
      if (tier !== "all" && c.riskTier !== tier) return false;
      if (!needle) return true;
      return (
        c.name.toLowerCase().includes(needle) ||
        (c.kind ?? "").toLowerCase().includes(needle) ||
        (c.owner ?? "").toLowerCase().includes(needle) ||
        (c.description ?? "").toLowerCase().includes(needle) ||
        c.id.toLowerCase().includes(needle)
      );
    });
  }, [capabilities, search, kind, tier]);

  return { search, setSearch, kind, setKind, tier, setTier, kinds, filtered };
}

export function CapabilityFilterBar({
  state,
  countLabel,
}: {
  state: CapabilityFilterState;
  countLabel: string;
}) {
  return (
    <div className="filters">
      <label>
        Search
        <input
          type="search"
          value={state.search}
          placeholder="name, owner, description or id"
          onChange={(e) => state.setSearch(e.target.value)}
          style={{ minWidth: 260 }}
        />
      </label>
      <label>
        Kind
        <select value={state.kind} onChange={(e) => state.setKind(e.target.value)}>
          <option value="all">All kinds</option>
          {state.kinds.map((k) => (
            <option key={k} value={k}>
              {k === "" ? "(no kind)" : k === "mcp_tool" ? "MCP tool" : k}
            </option>
          ))}
        </select>
      </label>
      <label>
        Risk tier
        <select value={state.tier} onChange={(e) => state.setTier(e.target.value)}>
          <option value="all">All tiers</option>
          {TIER_ORDER.map((t) => (
            <option key={t} value={t}>
              {TIER_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <span className="muted" style={{ marginLeft: "auto" }}>
        {countLabel}
      </span>
    </div>
  );
}
