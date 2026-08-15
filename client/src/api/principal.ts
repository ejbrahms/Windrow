import type { Principal } from "./types";

/** Instance principals mapped from a real running agent carry the human's actual name
 * (server/principals/) — prefer that over the agent/role name everywhere a principal is shown.
 * Mirrors server/app.js's own `principalDisplayName`. */
export function principalDisplayName(principal: Principal | null | undefined): string {
  if (!principal) return "";
  return principal.humanName || principal.name;
}

export interface PrincipalGroup {
  displayName: string;
  instances: Principal[];
}

/** Groups instance principals by display name — a human who has been spawned into several agent
 * ids (a respawn, a new session) otherwise shows up as one row/button per agent, repeating the
 * same human name over and over in whatever list or section is rendering them. Order of first
 * appearance is preserved so callers that pre-sort the input keep that order. */
export function groupPrincipalsByDisplayName(instances: Principal[]): PrincipalGroup[] {
  const groups: PrincipalGroup[] = [];
  const byName = new Map<string, PrincipalGroup>();
  for (const instance of instances) {
    const displayName = principalDisplayName(instance);
    let group = byName.get(displayName);
    if (!group) {
      group = { displayName, instances: [] };
      byName.set(displayName, group);
      groups.push(group);
    }
    group.instances.push(instance);
  }
  return groups;
}
