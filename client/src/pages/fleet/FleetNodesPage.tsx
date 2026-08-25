import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { fleet, num } from "../../api/fleet";
import type { FleetNode, HookIntegrityNode, HookStatus, HookDetail } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { LiveControl } from "../../components/LiveControl";
import { StatTile } from "../../components/StatTile";
import { Toggle } from "../../components/Toggle";
import { useAutoRefresh } from "../../hooks/useAutoRefresh";
import { CredentialBadge, HookStatusBadge, age, count, list, shortId, when } from "./shared";

/**
 * THE FLEET ROSTER AND ITS HOOK INTEGRITY, ONE PAGE.
 *
 * These were two routes — /fleet/nodes and /fleet/hooks — asking the same question from two angles
 * about the same list of machines. "Is this box still shipping, and is governance still wired on
 * it" is one health check, so it now lives behind one nav entry with a view switch, rather than
 * splitting the reader between two tables they had to hold in their head at once.
 *
 * TWO VIEWS, NOT TWO TABLES CRAMMED SIDE BY SIDE. The roster answers "what is on this fleet and
 * how stale is each" — sixteen machines, one row each, hook state as a single badge. Hook integrity
 * answers "which config files lost their wiring" — the installed/broken/tamper counts and the two
 * clocks that catch a compromised node that then went quiet. Sixteen columns on one line would read
 * as neither; the switch keeps each table the width its question needs, over one shared filter.
 */

// The roster's own idea of stale. Nodes ship usage on a five-second timer, so an hour of silence
// is a machine that is off, disconnected or gone — not a slow tick.
const SILENT_MS = 3600 * 1000;

// A hook report older than this is called out in the table. Node health ships on the same cadence
// as the rest of a node's reporting, so a day of silence is not a slow tick — it is a machine that
// stopped talking, which on the hook view is the finding rather than a display detail.
const STALE_REPORT_MS = 24 * 3600 * 1000;

type View = "roster" | "hooks";

function isSilent(node: FleetNode): boolean {
  // `silentForMs` is Postgres `numeric` and arrives as a string, so it goes through `num()` — a
  // direct comparison would be false for every row, and every silent node would read as live.
  const silent = num(node.silentForMs);
  return silent === null || silent > SILENT_MS;
}

function isStale(node: HookIntegrityNode): boolean {
  // Through `num()` because `reportAgeMs` is Postgres `numeric` and arrives as a string —
  // comparing that to a number directly is the kind of wrong that a type error catches for you.
  const reportAge = num(node.reportAgeMs);
  return reportAge !== null && reportAge > STALE_REPORT_MS;
}

function tally(nodes: HookIntegrityNode[], status: HookStatus): number {
  return nodes.filter((n) => (n.hookStatus ?? "unknown") === status).length;
}

// The muted subline under the hook status wants one sentence, so derive it: the backends that are
// installable but ungoverned right now (with the file an operator would go and fix), falling back
// to any config files central could not read.
function hookDetailLine(detail: HookDetail | null): string | null {
  if (!detail) return null;
  const broken = (detail.providers ?? []).filter((p) => p.installable && !p.installed);
  if (broken.length > 0) {
    return broken
      .map((p) => `${p.label ?? p.id}${p.configPath ? ` (${p.configPath})` : ""}`)
      .join(", ");
  }
  const unreadable = detail.unreadable ?? [];
  if (unreadable.length > 0) {
    return `${unreadable.length} config file${unreadable.length === 1 ? "" : "s"} could not be read`;
  }
  return null;
}

// Shared filter over both tables — a node is a node in either view, so the same needle matches the
// same machines whichever table is up.
function matches(needle: string, fields: (string | null | undefined)[]): boolean {
  if (!needle) return true;
  return fields
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(needle));
}

export function FleetNodesPage() {
  const [view, setView] = useState<View>("roster");
  const [query, setQuery] = useState("");
  const [onlyUnhealthy, setOnlyUnhealthy] = useState(false);

  const roster = useFetch(() => fleet.nodes(), []);
  const hookReport = useFetch(
    () => fleet.hooks(onlyUnhealthy ? { unhealthy: 1 } : {}),
    [onlyUnhealthy],
  );

  // One tick reloads both fetches — the roster and the hook report answer the same health question
  // from two angles, so a live page keeps them on the same clock rather than letting the hidden view
  // go stale behind the switch.
  const reloadAll = () => {
    roster.reload();
    hookReport.reload();
  };
  const auto = useAutoRefresh({
    storageKey: "fleet-nodes-auto-refresh",
    reload: reloadAll,
    dataSignal: roster.data,
  });

  const needle = query.trim().toLowerCase();

  const nodes = useMemo(() => list(roster.data?.nodes), [roster.data]);
  const filteredNodes = useMemo(
    () => nodes.filter((n) => matches(needle, [n.nodeId, n.hostname, n.osUser, n.certSubject])),
    [nodes, needle],
  );

  const hookNodes = useMemo(() => list(hookReport.data?.nodes), [hookReport.data]);
  const filteredHookNodes = useMemo(
    () => hookNodes.filter((n) => matches(needle, [n.nodeId, n.hostname, n.osUser])),
    [hookNodes, needle],
  );

  // Roster tiles.
  const live = nodes.filter((n) => !isSilent(n)).length;
  const rebuilt = nodes.filter((n) => (n.incarnationCount ?? 1) > 1).length;
  const ungovernedRoster = nodes.filter((n) => (n.hookStatus ?? "unknown") !== "installed").length;
  // A paused node is one overturning a central deny on its own signature — §5's alarming state, and
  // the reason it earns a column here rather than living only on the enforcement page: a node that
  // is not enforcing must be visible on the roster without opening anything.
  const notEnforcing = nodes.filter((n) => n.paused === true).length;

  // Hook tiles.
  const installed = tally(hookNodes, "installed");
  const ungovernedHooks = hookNodes.length - installed;
  const stale = hookNodes.filter(isStale).length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Nodes &amp; hook integrity</h1>
          <p>
            Every machine that has ever shipped to this central, and whether governance is still
            wired on it. The roster is the fleet's memory — how stale each node is, how many times it
            has been rebuilt, whether it is still enforcing. Hook integrity is the check every other
            view here presupposes an answer to: is what a node did being watched at all.
          </p>
        </div>
        <LiveControl auto={auto} onRefresh={reloadAll}>
          {view === "hooks" && (
            <>
              <Toggle
                checked={onlyUnhealthy}
                onChange={setOnlyUnhealthy}
                label="Show only nodes that are not fully installed"
              />
              <span className="live-label">Problems only</span>
            </>
          )}
        </LiveControl>
      </div>

      <div className="tabs" role="tablist" aria-label="Node view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "roster"}
          className={"tab" + (view === "roster" ? " active" : "")}
          onClick={() => setView("roster")}
        >
          Roster
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "hooks"}
          className={"tab" + (view === "hooks" ? " active" : "")}
          onClick={() => setView("hooks")}
        >
          Hook integrity
        </button>
      </div>

      {view === "roster" ? (
        <>
          {roster.error && (
            <div className="error-banner">Could not load the node roster: {roster.error}</div>
          )}
          {roster.loading && <div className="loading">Loading the node roster…</div>}

          {roster.data && (
            <div className="stat-grid">
              <StatTile
                label="Nodes on the roster"
                value={count(nodes.length)}
                sub={`${live} seen in the last hour`}
              />
              <StatTile
                label="Not fully governed"
                value={count(ungovernedRoster)}
                sub="hooks tampered, missing or never reported"
              />
              <StatTile
                label="Not enforcing"
                value={count(notEnforcing)}
                sub="a pause is overturning a central deny"
              />
              <StatTile
                label="Rebuilt at least once"
                value={count(rebuilt)}
                sub="more than one incarnation has shipped"
              />
            </div>
          )}

          <div className="card">
            <div className="tabs">
              <input
                className="tab-search"
                type="search"
                placeholder="Filter by host, node id or user…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter nodes"
              />
            </div>
            {roster.data && filteredNodes.length === 0 ? (
              <div className="empty-state">
                {nodes.length === 0
                  ? "No node has shipped anything to this central yet."
                  : "No node matches that filter."}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Hooks</th>
                    <th>Enforcing</th>
                    <th>Credential</th>
                    <th>Last seen</th>
                    <th>Events</th>
                    <th>Shipments</th>
                    <th>Rebuilds</th>
                    <th>Native</th>
                    <th>Skew</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredNodes.map((node) => (
                    <tr key={node.nodeId}>
                      <td>
                        <Link to={`/fleet/nodes/${encodeURIComponent(node.nodeId)}`}>
                          {node.hostname ?? node.nodeId}
                        </Link>
                        <div className="muted">
                          <code>{node.nodeId}</code>
                          {node.osUser && ` · ${node.osUser}`}
                        </div>
                      </td>
                      <td>
                        <HookStatusBadge status={node.hookStatus} />
                      </td>
                      <td>
                        {node.paused === true ? (
                          <Link to="/fleet/enforcement" title={node.pauseReason ?? undefined}>
                            <span className="badge badge-denied">Paused</span>
                          </Link>
                        ) : node.paused === false ? (
                          <span className="muted">yes</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <CredentialBadge state={node.credentialState} />
                      </td>
                      <td className="muted" title={node.lastSeenAt ?? undefined}>
                        {age(node.silentForMs)}
                        {isSilent(node) && (
                          <>
                            {" "}
                            <span className="badge badge-error">Silent</span>
                          </>
                        )}
                      </td>
                      <td className="tabular">{count(node.eventCount)}</td>
                      <td className="tabular">
                        {count(node.shipmentCount)}
                        <div className="muted">seq {count(node.lastSeq)}</div>
                      </td>
                      <td className="tabular">
                        {count(node.incarnationCount)}
                        {node.lastIncarnation && (
                          <div className="muted" title={node.lastIncarnation}>
                            {shortId(node.lastIncarnation)}
                          </div>
                        )}
                      </td>
                      <td className="muted" title={node.nativeLastSeenAt ?? undefined}>
                        {node.nativeLastSeenAt ? when(node.nativeLastSeenAt) : "never shipped"}
                      </td>
                      <td className="muted tabular">
                        {node.lastClockSkewMs === null
                          ? "—"
                          : `${node.lastClockSkewMs.toLocaleString()} ms`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : (
        <>
          {hookReport.error && (
            <div className="error-banner">
              Could not load hook integrity: {hookReport.error}{" "}
              <button type="button" className="btn" onClick={hookReport.reload}>
                Retry
              </button>
            </div>
          )}
          {hookReport.loading && (
            <div className="loading">Loading hook integrity across the fleet…</div>
          )}

          {hookReport.data && !onlyUnhealthy && (
            <div className="stat-grid">
              <StatTile
                label="Nodes governed"
                value={`${installed} / ${hookNodes.length}`}
                sub={
                  ungovernedHooks === 0
                    ? "every node reports its hooks installed"
                    : `${ungovernedHooks} not fully installed`
                }
              />
              <StatTile
                label="Tampered"
                value={count(tally(hookNodes, "tampered"))}
                sub="hook wiring was found altered or removed"
              />
              <StatTile
                label="Missing"
                value={count(tally(hookNodes, "missing"))}
                sub="a backend is installed with no hooks in it"
              />
              <StatTile
                label="Reports gone stale"
                value={count(stale)}
                sub="no hook report in the last 24 hours"
              />
            </div>
          )}

          <div className="card">
            <div className="tabs">
              <input
                className="tab-search"
                type="search"
                placeholder="Filter by host, node id or user…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter nodes"
              />
            </div>
            <h2>
              {onlyUnhealthy
                ? "Nodes that are not fully installed"
                : "Every node central has heard from"}
            </h2>
            {hookReport.data && filteredHookNodes.length === 0 ? (
              <div className="empty-state">
                {hookNodes.length === 0
                  ? onlyUnhealthy
                    ? "Every node that has reported says its hooks are installed."
                    : "No node has reported its hook wiring yet. A node ships this with its node health; until the first report lands there is nothing here to read."
                  : "No node matches that filter."}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Status</th>
                    <th>Installed</th>
                    <th>Broken</th>
                    <th>Tampers</th>
                    <th>Last tamper</th>
                    <th>Node checked</th>
                    <th>Central heard</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHookNodes.map((node) => (
                    <tr key={node.nodeId}>
                      <td>
                        {node.hostname ?? node.nodeId}
                        <div className="muted">
                          <code>{node.nodeId}</code>
                          {node.osUser && ` · ${node.osUser}`}
                        </div>
                      </td>
                      <td>
                        <HookStatusBadge status={node.hookStatus} />
                        {(() => {
                          const line = hookDetailLine(node.hookDetail);
                          return line ? <div className="muted">{line}</div> : null;
                        })()}
                      </td>
                      <td className="tabular">
                        {node.hookInstalledCount === null || node.hookInstallableCount === null
                          ? "—"
                          : `${node.hookInstalledCount} / ${node.hookInstallableCount}`}
                      </td>
                      <td className="tabular">{count(node.hookBrokenCount)}</td>
                      <td className="tabular">{count(node.hookTamperCount)}</td>
                      <td className="muted">{when(node.hookLastTamperAt)}</td>
                      <td className="muted" title={node.hookCheckedAt ?? undefined}>
                        {when(node.hookCheckedAt)}
                      </td>
                      <td className="muted" title={node.hookReportedAt ?? undefined}>
                        {age(node.reportAgeMs)}
                        {isStale(node) && (
                          <>
                            {" "}
                            <span className="badge badge-error">Stale</span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
