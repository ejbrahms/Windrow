import type { Principal } from "./types";

/** The label to *show* for a principal: the platform-assigned nickname an instance carries
 * (server/principals/), falling back to the agent/role name. Display only — it is a cast-pack
 * nickname, not a person, so it must never be used as a grouping or identity key
 * (docs/design/global-identity-and-central-db.md §1.1). Browser-side twin of the server's
 * `principalDisplayName` (server/principals/registry.js), which cannot be require()d across the
 * bundle boundary; the one deliberate difference is the no-principal fallback — the server takes
 * a fallback id, a React caller renders an empty label. Keep the two in step. */
export function principalDisplayName(principal: Principal | null | undefined): string {
  if (!principal) return "";
  return principal.humanName || principal.name;
}
