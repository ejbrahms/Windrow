import { useEffect, useRef, useState } from "react";

/**
 * The live-page machinery every dashboard here repeats: a persisted on/off toggle, an interval that
 * reloads on a cadence, a stamp of when the numbers on screen actually landed, and a clock to keep
 * the "how stale is this" label honest between refreshes.
 *
 * Lifted verbatim out of DashboardPage, which grew all four pieces first. The fleet pages were
 * static-until-refresh — a number that stopped being true minutes ago, with no dot to say so — and
 * hand-copying the interval-plus-clock dance onto each is four chances for two pages to disagree
 * about what "live" means on the same screen. One hook, one definition.
 */

// Ten seconds is short enough that a call you just made shows up while you're still looking for it,
// and long enough that the server isn't recomputing a summary faster than its own buckets change.
export const AUTO_REFRESH_MS = 10_000;

/** "just now" / "12s ago" — the only question anyone has of a live page is how stale it is. */
export function sinceLabel(at: number | null, now: number): string {
  if (at === null) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

// Live by default: these pages are normally left open to watch, and the commonest way they mislead
// is by showing a number that stopped being true minutes ago. Opting out is one click and sticks.
function loadAutoRefresh(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) !== "off";
  } catch {
    // Storage unavailable (private browsing, etc.) — default to live.
    return true;
  }
}

export interface AutoRefresh {
  /** Whether the interval is currently running. */
  autoRefresh: boolean;
  setAutoRefresh: (next: boolean) => void;
  /** When the on-screen data last landed, or null before the first load. */
  updatedAt: number | null;
  /** A clock that re-renders once a second, so the staleness label ticks on its own. */
  now: number;
  /** The pre-formatted "12s ago" label for `updatedAt`. */
  since: string;
}

export interface UseAutoRefreshOptions {
  /** localStorage key the on/off choice persists under — one per page so pages don't share a toggle. */
  storageKey: string;
  /** Called on every visible tick. Batch several reloads inside one closure — a new closure each
   *  render is fine, it is read through a ref so changing it does not restart the countdown. */
  reload: () => void;
  /** The fetched data whose arrival stamps `updatedAt`. Stamped from the data landing, not the
   *  request going out, so "12s ago" describes the numbers on screen rather than an attempt in
   *  flight. Pass the primary query's `data`; any truthy change re-stamps. */
  dataSignal: unknown;
  intervalMs?: number;
}

export function useAutoRefresh({
  storageKey,
  reload,
  dataSignal,
  intervalMs = AUTO_REFRESH_MS,
}: UseAutoRefreshOptions): AutoRefresh {
  const [autoRefresh, setAutoRefresh] = useState(() => loadAutoRefresh(storageKey));

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, autoRefresh ? "on" : "off");
    } catch {
      // Storage unavailable — the toggle still works for this session.
    }
  }, [storageKey, autoRefresh]);

  // Read through a ref inside the interval so changing a filter (which hands back a new `reload`
  // closure) doesn't tear the timer down and start the countdown over.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      // A backgrounded tab is nobody watching: skip the round trip rather than keep the server
      // busy for a window that isn't on screen. The next visible tick catches up.
      if (document.hidden) return;
      reloadRef.current();
    }, intervalMs);
    return () => clearInterval(id);
  }, [autoRefresh, intervalMs]);

  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  useEffect(() => {
    if (dataSignal) setUpdatedAt(Date.now());
  }, [dataSignal]);

  // Re-renders the staleness label on its own clock; without this it would sit at "just now"
  // between refreshes, which is exactly the claim it exists to stop the page making.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  return { autoRefresh, setAutoRefresh, updatedAt, now, since: sinceLabel(updatedAt, now) };
}
