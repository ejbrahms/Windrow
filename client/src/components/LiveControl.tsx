import type { ReactNode } from "react";
import { Toggle } from "./Toggle";
import type { AutoRefresh } from "../hooks/useAutoRefresh";

/**
 * The header control every live page carries: an auto-refresh toggle, a Live/Paused readout with the
 * pulsing dot, a manual Refresh button, and how long ago the numbers landed. Lifted out of
 * DashboardPage so the fleet pages read the same way rather than each re-deriving the markup.
 *
 * `children` render first, before the toggle, so a page that already has a WindowPicker in its
 * `.live-control` keeps it to the left of the live readout instead of in a second row.
 */
export function LiveControl({
  auto,
  onRefresh,
  children,
}: {
  auto: AutoRefresh;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="live-control">
      {children}
      <Toggle
        checked={auto.autoRefresh}
        onChange={auto.setAutoRefresh}
        label={auto.autoRefresh ? "Turn off auto-refresh" : "Turn on auto-refresh"}
      />
      <span className="live-label">
        {auto.autoRefresh ? (
          <>
            <span className="live-dot" aria-hidden="true" />
            Live
          </>
        ) : (
          "Paused"
        )}
      </span>
      <button type="button" className="tab live-refresh" onClick={onRefresh}>
        Refresh
      </button>
      <span className="muted live-since">Updated {auto.since}</span>
    </div>
  );
}
