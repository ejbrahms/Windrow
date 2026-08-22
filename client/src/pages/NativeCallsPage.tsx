import { useEffect, useRef, useState } from "react";
import { NativeCallsCard } from "../components/NativeCallsCard";
import { Toggle } from "../components/Toggle";
import type { NativeCallsGranularity } from "../api/nativeCalls";

/**
 * Native harness tools (Read, Edit, Write, Bash, Grep, Glob, …) carry no capability, so the
 * broker never sees them and no governed view on the Overview can show them at all.
 *
 * Its own page rather than a card at the bottom of the dashboard, because that placement was the
 * problem: a table of tool calls sitting under the broker's own charts reads as a table of
 * decisions. Nothing here was allowed or refused on governance grounds — these calls always run,
 * and this is observability only.
 *
 * The page owns the range and the refresh clock rather than the card, because both controls sit in
 * the page header and the range picks the chart's bucket width as well as the window: an hour of
 * observations is only legible per minute, a day of them only per hour.
 */

const AUTO_REFRESH_STORAGE_KEY = "native-calls-auto-refresh";
const RANGE_STORAGE_KEY = "native-calls-range";

// Matches the dashboard's cadence for the same reason: short enough that a call you just made
// turns up while you are still looking for it, long enough not to recompute a minute-bucketed
// window faster than its own buckets change.
const AUTO_REFRESH_MS = 10_000;

interface Range {
  key: string;
  label: string;
  windowMinutes: number;
  granularity: NativeCallsGranularity;
}

// Two ranges, each paired with the only bucket width that reads at that span. Offering the window
// and the grain as separate controls would let someone ask for 60 one-minute-wide points across a
// day, which is a chart of 2% of the day.
const RANGES: Range[] = [
  { key: "hour", label: "Last hour", windowMinutes: 60, granularity: "minute" },
  { key: "day", label: "Last 24 hours", windowMinutes: 1440, granularity: "hour" },
];

function loadRange(): Range {
  try {
    const stored = localStorage.getItem(RANGE_STORAGE_KEY);
    return RANGES.find((r) => r.key === stored) ?? RANGES[1];
  } catch {
    // Storage unavailable (private browsing, etc.) — fall back to the default range.
    return RANGES[1];
  }
}

// Live by default: this page is left open to watch a fleet work, and the commonest way it misleads
// is by showing a count that stopped being true minutes ago. Opting out is one click and sticks.
function loadAutoRefresh(): boolean {
  try {
    return localStorage.getItem(AUTO_REFRESH_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** "just now" / "12s ago" — the only question anyone has of a live page is how stale it is. */
function sinceLabel(at: number | null, now: number): string {
  if (at === null) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function NativeCallsPage() {
  const [range, setRange] = useState(loadRange);
  const [autoRefresh, setAutoRefresh] = useState(loadAutoRefresh);
  const [refreshKey, setRefreshKey] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, autoRefresh ? "on" : "off");
      localStorage.setItem(RANGE_STORAGE_KEY, range.key);
    } catch {
      // Same as above — the controls still work for this session, they just won't persist.
    }
  }, [autoRefresh, range]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      // A backgrounded tab is nobody watching: skip the round trip rather than keep the server
      // querying the largest table here for a window that isn't on screen. The next visible tick
      // catches up, and it catches up completely — these are absolute counts, not a delta feed.
      if (document.hidden) return;
      setRefreshKey((k) => k + 1);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [autoRefresh]);

  // Re-renders the staleness label on its own clock; without this it would sit at "just now"
  // between refreshes, which is exactly the claim it exists to stop the page making. It also
  // re-renders the card's relative "3m ago" column, which has the same problem.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Held in a ref so the card's onUpdated doesn't have to be a stable callback: the card fires it
  // whenever fresh data lands, and the page only needs the latest stamp.
  const updatedRef = useRef(setUpdatedAt);
  updatedRef.current = setUpdatedAt;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Native tool calls</h1>
          <p>
            What the harness's own tools did — observed, not governed. These calls carry no
            capability and were never grant-checked; they arrive off a best-effort spool, so an
            empty window means nothing was observed rather than nothing happened.
          </p>
        </div>
        <div className="live-control">
          <div className="tabs" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                className={"tab" + (range.key === r.key ? " active" : "")}
                aria-pressed={range.key === r.key}
                onClick={() => setRange(r)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <Toggle
            checked={autoRefresh}
            onChange={setAutoRefresh}
            label={autoRefresh ? "Turn off auto-refresh" : "Turn on auto-refresh"}
          />
          <span className="live-label">
            {autoRefresh ? (
              <>
                <span className="live-dot" aria-hidden="true" />
                Live
              </>
            ) : (
              "Paused"
            )}
          </span>
          <button
            type="button"
            className="tab live-refresh"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            Refresh
          </button>
          <span className="muted live-since">Updated {sinceLabel(updatedAt, now)}</span>
        </div>
      </div>

      <NativeCallsCard
        windowMinutes={range.windowMinutes}
        granularity={range.granularity}
        refreshKey={refreshKey}
        onUpdated={() => updatedRef.current(Date.now())}
      />
    </div>
  );
}
