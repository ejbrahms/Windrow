import { qs, request } from "./client";

/**
 * Native harness tool calls — Read, Edit, Write, Bash, Grep, Glob and friends.
 *
 * These are *observations*, not governed decisions, and the distinction is load-bearing enough
 * that they live in their own table (`native_tool_events`) and their own api module rather than
 * anywhere near `UsageEvent`:
 *
 *   - a native tool has no registered capability, so no grant was ever consulted and nothing was
 *     ever allowed or refused on governance grounds — these calls were always going to run;
 *   - `usage_events` is hash-chained for tamper evidence and every row in it is a real decision,
 *     whereas these arrive late, in batches, off a best-effort spool drain that may drop rows
 *     under load. Folding them into the chain would weaken a guarantee to gain a log line.
 *
 * So: nothing here should be summed together with usage, and any UI over it has to say
 * "observed" rather than "allowed". See NativeCallsCard.
 */

/** Only three states, and none of them is a governance verdict: the tool ran, the tool failed, or
 * the harness itself refused it (a permission rule, not a grant check). Deliberately *not*
 * `UsageOutcome` — that type carries "approved", which only means something for a call that went
 * through the broker. */
export type NativeToolOutcome = "ok" | "error" | "denied";

export interface NativeToolEvent {
  id: string;
  principalId: string;
  /** The harness tool name as invoked: "Read", "Bash", "Edit", … */
  toolName: string;
  /** The one argument worth keeping: a file path, a glob, a url — and for Bash only the program
   * name ("git", "npm"), never the full command line, since the arguments routinely carry
   * secrets and paths that nobody consented to log. */
  detail: string | null;
  ts: string;
  outcome: NativeToolOutcome;
  /** Set only on "denied" — why the harness refused it. */
  reason: string | null;
  sessionId: string | null;
  // The calling agent, snapshotted onto the observation for the same reason UsageEvent does it:
  // the principal row is mutable, so joining to it would rewrite what the past looked like.
  actorLoomId: string | null;
  /** The loom's display name at call time ("Finn", "Hana"), recorded on the event rather than
   *  joined for — an instance principal's `name` column is its raw loom id, and its `humanName` is
   *  write-once metadata that is simply null on rows registered before it was captured. Null on
   *  observations that predate this column. */
  actorHumanName: string | null;
  actorAgentType: string | null;
  actorBackend: string | null;
  actorField: string | null;
  osUser: string | null;
  hostname: string | null;
}

export interface NativeToolByTool {
  toolName: string;
  count: number;
  errors: number;
  denied: number;
}

export interface NativeToolByPrincipal {
  principalId: string;
  name: string;
  count: number;
}

export interface NativeCallsSummary {
  total: number;
  errors: number;
  denied: number;
  /** The retained observation window: oldest and newest row the server still holds. Both null
   * when there are no rows at all — which is what lets a UI tell "nothing has been observed yet"
   * apart from "the retention window has aged everything out". */
  observedFrom: string | null;
  observedTo: string | null;
  /** Descending by count. */
  byTool: NativeToolByTool[];
  /** Descending by count. */
  byPrincipal: NativeToolByPrincipal[];
}

export interface NativeCallsListParams {
  limit?: number;
  principalId?: string;
  toolName?: string;
  /** ISO timestamp — only observations at or after this. */
  since?: string;
}

export const nativeCalls = {
  /** Newest first; the server defaults to 100 when `limit` is omitted. */
  list: (params: NativeCallsListParams = {}) => request<NativeToolEvent[]>(`/native-calls${qs({ ...params })}`),
  /** Server default window is 1440 minutes (24h). */
  summary: (params: { windowMinutes?: number } = {}) =>
    request<NativeCallsSummary>(`/native-calls/summary${qs({ ...params })}`),
};
