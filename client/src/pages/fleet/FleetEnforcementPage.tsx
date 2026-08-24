import { useMemo } from "react";
import { Link } from "react-router-dom";
import { fleet } from "../../api/fleet";
import type { DivergenceNode } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { StatTile } from "../../components/StatTile";
import { CredentialBadge, TierBadges, count, list, when } from "./shared";

/**
 * IS EVERY NODE ACTUALLY ENFORCING RIGHT NOW — the short list of the ones that are not.
 * docs/design/disposable-nodes.md §5.
 *
 * THE RULE THIS PAGE IS: narrowing is free, widening is reported. A node cannot write a grant, but
 * it can overturn a healthy central deny for up to 30 minutes at a time on its own signature — an
 * *enforcement pause* — and until this shipped central never learned. That is the alarming state,
 * and it reads red. A *grace lease* is a different thing that must not be confused with it: it
 * softens faults for up to 60 minutes and is NOT a bypass of a real deny, so it is ordinary
 * maintenance and reads amber. The third reason is §2.2's year fuse: a node's own certificate
 * expires and nothing used to renew it, which silently took the node offline.
 *
 * AN EMPTY LIST IS THE GOOD STATE. Only diverging nodes come back from the endpoint, so nothing to
 * show means every node is enforcing — this page says exactly that in words rather than drawing an
 * empty table, because a blank table reads as "did this even load".
 */

function isPaused(n: DivergenceNode): boolean {
  return n.paused === true;
}
function isLeased(n: DivergenceNode): boolean {
  return n.leased === true;
}
function credAtRisk(n: DivergenceNode): boolean {
  return (
    n.credentialAtRisk === true ||
    n.credentialState === "expired" ||
    n.credentialState === "unreadable"
  );
}

// Where the "suppressed denials" number links: to this node's journal, narrowed to the current
// pause window when there is one, because that is the query §5 says the pause id exists to answer.
function journalHref(n: DivergenceNode): string {
  const base = `/fleet/nodes/${encodeURIComponent(n.nodeId)}/journal`;
  return n.pauseId ? `${base}?pauseId=${encodeURIComponent(n.pauseId)}` : base;
}

export function FleetEnforcementPage() {
  const { data, loading, error, reload } = useFetch(() => fleet.divergence(), []);

  const nodes = useMemo(() => list(data?.nodes), [data]);
  const paused = nodes.filter(isPaused).length;
  const leased = nodes.filter(isLeased).length;
  const atRisk = nodes.filter(credAtRisk).length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Enforcement divergence</h1>
          <p>
            The nodes that are not doing what you think they are doing right now — an{" "}
            <strong>enforcement pause</strong> holding off a real deny, a{" "}
            <strong>grace lease</strong> softening faults, or a certificate about to expire.
            Narrowing itself is free and silent; these are the widenings and faults that get
            reported. A pause is the alarming one — a node overturning central on its own signature;
            a grace lease is ordinary maintenance.
          </p>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          Could not load enforcement divergence: {error}{" "}
          <button type="button" className="btn" onClick={reload}>
            Retry
          </button>
        </div>
      )}
      {loading && <div className="loading">Checking which nodes are not enforcing…</div>}

      {data && nodes.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <strong>Every node is enforcing.</strong> No node is holding off a deny with an
            enforcement pause, running on a grace lease, or about to lose its credential.
          </div>
        </div>
      ) : (
        data && (
          <>
            <div className="stat-grid">
              <StatTile
                label="Not enforcing"
                value={count(paused)}
                sub="a pause is overturning a central deny"
              />
              <StatTile
                label="On a grace lease"
                value={count(leased)}
                sub="faults softened — not a bypass of a deny"
              />
              <StatTile
                label="Credential at risk"
                value={count(atRisk)}
                sub="expiring, expired or unreadable"
              />
            </div>

            <div className="card">
              <h2>Nodes that are not fully enforcing</h2>
              <table>
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Divergence</th>
                    <th>Tiers</th>
                    <th>Until</th>
                    <th>Suppressed</th>
                    <th>Credential</th>
                    <th>Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((n) => (
                    <tr key={n.nodeId}>
                      <td>
                        <Link to={`/fleet/nodes/${encodeURIComponent(n.nodeId)}`}>
                          {n.label ?? n.nodeId}
                        </Link>
                        <div className="muted">
                          <code>{n.nodeId}</code>
                        </div>
                      </td>
                      <td>
                        {isPaused(n) && (
                          <div>
                            <span className="badge badge-denied">Paused</span>
                            {(n.pauseReason || n.pauseIssuedBy) && (
                              <div className="muted">
                                {n.pauseReason ? `“${n.pauseReason}”` : null}
                                {n.pauseReason && n.pauseIssuedBy ? " · " : null}
                                {n.pauseIssuedBy ? `by ${n.pauseIssuedBy}` : null}
                              </div>
                            )}
                          </div>
                        )}
                        {isLeased(n) && (
                          <div>
                            <span className="badge badge-error">Grace lease</span>
                          </div>
                        )}
                        {!isPaused(n) && !isLeased(n) && (
                          <span className="muted">credential only</span>
                        )}
                      </td>
                      <td>
                        {isPaused(n) &&
                          (n.pauseTiers ? (
                            <TierBadges tiers={n.pauseTiers} />
                          ) : (
                            <span className="muted">—</span>
                          ))}
                        {isLeased(n) && n.leaseTiers && (
                          <div className="muted">
                            lease: <TierBadges tiers={n.leaseTiers} />
                          </div>
                        )}
                        {!isPaused(n) && !isLeased(n) && <span className="muted">—</span>}
                      </td>
                      <td className="muted">
                        {isPaused(n) && n.pauseUntil && <div>{when(n.pauseUntil)}</div>}
                        {isLeased(n) && n.leaseUntil && (
                          <div className="muted">lease {when(n.leaseUntil)}</div>
                        )}
                        {!isPaused(n) && !isLeased(n) && "—"}
                      </td>
                      <td className="tabular">
                        {/* The count of what a pause let through, one click from the entries
                            themselves — the evidence a pause ever happened, since nothing failed
                            while it ran. */}
                        {n.suppressedDenials ? (
                          <Link to={journalHref(n)}>{count(n.suppressedDenials)}</Link>
                        ) : (
                          <span className="muted">{count(n.suppressedDenials)}</span>
                        )}
                      </td>
                      <td>
                        <CredentialBadge state={n.credentialState} />
                        {n.credentialNotAfter && (
                          <div className="muted" title={n.credentialNotAfter}>
                            {when(n.credentialNotAfter)}
                          </div>
                        )}
                      </td>
                      <td className="muted" title={n.lastSeenAt ?? undefined}>
                        {when(n.lastSeenAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      )}
    </div>
  );
}
