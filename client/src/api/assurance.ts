import type { AssuranceLevel } from "./types";

// How strongly an identity was established (docs/design/global-identity-and-central-db.md §1.4).
// One definition, shared by the principals table (where it describes the subject key) and the
// recent-calls table (where it describes a single call), so the two never disagree about what
// tier 2 is called. The badge that renders it lives with the other badges in
// components/Badge.tsx; this file stays free of JSX so the server-facing vocabulary and the
// component that draws it aren't the same edit.
//
// Server side is server/principals/subject.js — keep the vocabulary in step with it.

export const ASSURANCE_LONG: Record<AssuranceLevel, string> = {
  3: "server-verified",
  2: "OS-read, this machine",
  1: "env-derived (display only)",
};

export const ASSURANCE_SHORT: Record<AssuranceLevel, string> = {
  3: "Verified",
  2: "OS-read",
  1: "Env",
};

export function isAssuranceLevel(level: number | null | undefined): level is AssuranceLevel {
  return level === 1 || level === 2 || level === 3;
}

/** Full label, for a column with room. Em dash for "not recorded" — not a fourth tier. */
export function assuranceLabel(level: number | null | undefined): string {
  return isAssuranceLevel(level) ? ASSURANCE_LONG[level] : "—";
}
