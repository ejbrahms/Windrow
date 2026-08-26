import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useHost } from "../hooks/useHost";
import type { PageScope } from "../hooks/useHost";

/**
 * "Open this on the node" — the page docs/design/dashboard-placement.md asks for in one line:
 * *one artifact, and a page that says 'open this on the node' beats a button that 404s.*
 *
 * The bundle is served by central now, and central mounts no machine-local route. Rather than
 * ship a second build, or let a stale bookmark present a Providers page whose every button
 * returns a 404 with no explanation, a page outside its host renders this instead — which says
 * where the function went, and why it went there.
 *
 * It is deliberately not an error banner. Nothing has failed: the route is on another host by
 * design, and the design is the thing worth explaining.
 *
 * TWO ANSWERS, NOT ONE, and the difference is the whole of the fix below. A machine-local page
 * really did become a command — installing hooks, choosing a topology, pausing enforcement are
 * things you do to one PC and they are `npm run …` now. But the POLICY pages did not become
 * commands: they moved to central, which is the single writer for policy and is serving this very
 * bundle. Telling someone standing on central that grants live behind a CLI would send them to a
 * machine that cannot write a grant at all — the node's tables are a read-only mirror. So a route
 * in `MOVED_TO_CENTRAL` gets a link to the page that now does its job, and everything else gets
 * the command table.
 */

const NODE_HELP = [
  { label: "Install hooks into a backend's config", how: "npm run providers:install claude" },
  { label: "Choose a topology and write windrow.env", how: "npm run setup" },
  { label: "Check the install end to end", how: "npm run verify:topology" },
  { label: "Pause enforcement to debug", how: "npm run denials:off" },
];

/**
 * The node-scoped routes whose function is now a page on central, keyed by the path the visitor
 * actually asked for.
 *
 * These four have NO command — there is no `npm run grant`, and the node could not honour one if
 * there were. Everything else in the machine-local set is genuinely machine-local and stays on the
 * table above.
 */
const MOVED_TO_CENTRAL: Record<string, { to: string; label: string; what: string }> = {
  "/grants": {
    to: "/policy/grants",
    label: "Grants",
    what: "Grant and revoke capabilities for a role or a person, fleet-wide.",
  },
  "/principals": {
    to: "/policy/principals",
    label: "Principals",
    what: "Every person, role and running instance the fleet knows, and whether each is allowed to act.",
  },
  "/catalog": {
    to: "/policy/catalog",
    label: "Capability catalog",
    what: "The canonical capability list, its risk tiers and its auto-grant switches.",
  },
  "/approvals": {
    to: "/policy/approvals",
    label: "Approvals",
    what: "Grant requests a node proposed, and the control-plane audit log.",
  },
};

function NotHere({ scope, title }: { scope: PageScope; title: string }) {
  const { host } = useHost();
  const { pathname } = useLocation();
  const onCentral = scope === "node";
  const isDemo = scope === "demo";
  const moved = onCentral ? MOVED_TO_CENTRAL[pathname] : undefined;

  // A demo-only surface (the Sandbox) reached on a real deployment: not a host mismatch to route
  // around, just a toy that ships only on the public demo. Say so plainly and point home.
  if (isDemo) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1>{title}</h1>
            <p>
              The Sandbox is a visitor-facing toy — a live, in-browser illustration of how the broker
              rules on a tool call. It ships only on the public read-only demo, not on a real
              deployment's console, so there is nothing to enable here.
            </p>
          </div>
        </div>
        <div className="card">
          <h2>Where to find it</h2>
          <p className="muted">
            Open the public demo to try it. On this deployment, the fleet and policy pages are the
            real thing — start at <Link to="/">the overview</Link>.
          </p>
          {host && <p className="muted">Detected host: {host.detail}.</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{title}</h1>
          <p>
            {moved ? (
              <>
                This page's job moved to central rather than away — central is the single writer for
                policy now, and it is the host serving this dashboard. The node's own copy of these
                tables is a read-only mirror it replicates and is no longer allowed to write.
              </>
            ) : onCentral ? (
              <>
                This page reads one machine's own state — its disk, its backend config files, its
                enforcement switch — and central holds none of that. It works only on the node it
                describes, which no longer serves a dashboard of its own.
              </>
            ) : (
              <>
                This page reads the fleet from central's store, and a node has no fleet to report
                on: it holds its own events and ships them upward. Open the dashboard central
                serves.
              </>
            )}
          </p>
        </div>
      </div>

      <div className="card">
        <h2>{moved ? "It is right here" : onCentral ? "Where this went" : "Where to find this"}</h2>
        {moved ? (
          <>
            <p className="muted">{moved.what}</p>
            <div className="grant-summary">
              <Link className="btn btn-primary" to={moved.to}>
                Go to {moved.label}
              </Link>
              <span className="muted">
                Nothing to run on the node for this one — a node cannot write a grant, a principal
                or a capability any more, so there is no command that would.
              </span>
            </div>
          </>
        ) : onCentral ? (
          <>
            <p className="muted">
              A node is a background service now, not a place anyone logs into
              (<code>docs/design/dashboard-placement.md</code>, item 4). The machine-local jobs the
              old node dashboard did are commands:
            </p>
            <table>
              <thead>
                <tr>
                  <th>To do this</th>
                  <th>Run this on the node</th>
                </tr>
              </thead>
              <tbody>
                {NODE_HELP.map((row) => (
                  <tr key={row.how}>
                    <td>{row.label}</td>
                    <td>
                      <code>{row.how}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              Granting, revoking and the capability catalog are not on that list because they are
              not commands — they are on <Link to="/policy/grants">Policy</Link>, here on central.
            </p>
          </>
        ) : (
          <p className="muted">
            Central serves <code>client/dist</code> over its own mTLS listener. The fleet pages —
            hook integrity, the node roster, native observations, alerts, shadow status and storage
            — are all there, and so is the policy control plane: grants, principals, the catalog
            and approvals.
          </p>
        )}
        {host && <p className="muted">Detected host: {host.detail}.</p>}
      </div>
    </div>
  );
}

/** Wraps a route. Renders the page where it works, and the explanation where it does not. */
export function HostGate({
  scope,
  title,
  children,
}: {
  scope: PageScope;
  title: string;
  children: ReactNode;
}) {
  const { loading, allows } = useHost();
  // Nothing is rendered until the probe settles, and that is the point: mounting the page first
  // would fire its fetches against a host that has no such route, so the "this lives elsewhere"
  // notice would arrive after the 404 it exists to prevent.
  if (loading) {
    return (
      <div className="page">
        <div className="loading">Checking which host is serving this dashboard…</div>
      </div>
    );
  }
  if (allows(scope)) return <>{children}</>;
  return <NotHere scope={scope} title={title} />;
}
