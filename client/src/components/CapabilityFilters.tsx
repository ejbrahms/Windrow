import { useMemo, useState } from "react";
import type { Capability, CapabilityKind, PackageStatus, RiskTier } from "../api/types";

// Shared filter state + logic for any page that lists capabilities and wants to narrow them by
// kind, risk tier, and/or capability package (server/packages.js) — the Catalog page had this
// first; Grants needed the same three questions ("what kind of thing," "how risky," "which
// provider/integration owns it"), so it's factored out here instead of a second hand-copy that
// drifts from the first the next time a filter is added.

const KIND_OPTIONS: { value: CapabilityKind | ""; label: string }[] = [
  { value: "", label: "All kinds" },
  { value: "skill", label: "Skill" },
  { value: "mcp_tool", label: "MCP tool" },
];

const TIER_OPTIONS: { value: RiskTier | ""; label: string }[] = [
  { value: "", label: "All risk tiers" },
  { value: "read_only", label: "Read-only" },
  { value: "mutating", label: "Mutating" },
  { value: "destructive", label: "Destructive" },
];

export interface CapabilityFilterState {
  kind: CapabilityKind | "";
  setKind: (v: CapabilityKind | "") => void;
  tier: RiskTier | "";
  setTier: (v: RiskTier | "") => void;
  // "" = every capability, "unpackaged" = owner matches no known package, else a package id.
  packageId: string;
  setPackageId: (v: string) => void;
  filtered: Capability[];
}

/**
 * `capabilities`/`packages` may still be loading (null) — the hook is safe to call before either
 * has resolved, it just filters an empty list until they have.
 */
export function useCapabilityFilters(
  capabilities: Capability[] | null | undefined,
  packages: PackageStatus[] | null | undefined,
): CapabilityFilterState {
  const [kind, setKind] = useState<CapabilityKind | "">("");
  const [tier, setTier] = useState<RiskTier | "">("");
  const [packageId, setPackageId] = useState<string>("");

  // Providers own no capabilities directly (owners: []) — a provider package would always filter
  // to zero rows, which reads as a bug rather than "correct, there's nothing there." Only offer
  // packages that actually own something.
  const filterablePackages = useMemo(() => (packages ?? []).filter((p) => p.owners.length > 0), [packages]);
  const packagedOwners = useMemo(() => new Set(filterablePackages.flatMap((p) => p.owners)), [filterablePackages]);

  const filtered = useMemo(() => {
    if (!capabilities) return [];
    return capabilities.filter((c) => {
      if (kind !== "" && c.kind !== kind) return false;
      if (tier !== "" && c.riskTier !== tier) return false;
      if (packageId === "unpackaged") return !packagedOwners.has(c.owner);
      if (packageId !== "") {
        const pkg = filterablePackages.find((p) => p.id === packageId);
        if (!pkg || !pkg.owners.includes(c.owner)) return false;
      }
      return true;
    });
  }, [capabilities, kind, tier, packageId, filterablePackages, packagedOwners]);

  return { kind, setKind, tier, setTier, packageId, setPackageId, filtered };
}

/** The <select> trio itself — rendered identically wherever `useCapabilityFilters` is used. */
export function CapabilityFilterBar({
  state,
  packages,
  countLabel,
}: {
  state: CapabilityFilterState;
  packages: PackageStatus[] | null | undefined;
  /** e.g. "42 of 90 capabilities" — each page phrases its own denominator (all vs. curated). */
  countLabel?: string;
}) {
  const filterablePackages = (packages ?? []).filter((p) => p.owners.length > 0);
  const providerPackages = filterablePackages.filter((p) => p.kind === "provider");
  const integrationPackages = filterablePackages.filter((p) => p.kind === "integration");

  return (
    <div className="filters">
      <label>
        Kind
        <select value={state.kind} onChange={(e) => state.setKind(e.target.value as CapabilityKind | "")}>
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Risk tier
        <select value={state.tier} onChange={(e) => state.setTier(e.target.value as RiskTier | "")}>
          {TIER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Package
        <select value={state.packageId} onChange={(e) => state.setPackageId(e.target.value)}>
          <option value="">All packages</option>
          {providerPackages.length > 0 && (
            <optgroup label="Providers">
              {providerPackages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          )}
          {integrationPackages.length > 0 && (
            <optgroup label="Integrations">
              {integrationPackages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          )}
          <option value="unpackaged">Unpackaged (no matching owner)</option>
        </select>
      </label>
      {countLabel && (
        <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
          {countLabel}
        </span>
      )}
    </div>
  );
}
