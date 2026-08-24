import { fleet } from "../../api/fleet";
import type { SettingsParameter } from "../../api/fleet";
import { useFetch } from "../../api/useFetch";
import { StatTile } from "../../components/StatTile";
import { count } from "./shared";

/**
 * Central's own settings — the surface the node dashboard used to carry a "Config" menu for and
 * central never had one at all (docs/design/dashboard-placement.md item 4). It shows two
 * genuinely-central things and edits neither: central's deployment posture, and the fleet-wide
 * policy parameters it distributes to every node.
 *
 * READ-ONLY BY DESIGN. The policy parameters below are tightened by NODE PROFILES, whose write path
 * already lives at /api/policy/node-profiles and `npm run` equivalents — this page is the view that
 * was missing, not a second editor. The provider/hook side of the old node "Config" menu became a
 * CLI (`npm run providers:install`) and stays there; nothing machine-local is resurrected here.
 */

/** Human labels and one-line meaning for each policy parameter, keyed by server/policy/nodeConfig.js's
 *  key. Presentation, so it lives here rather than on the wire. A key with no entry still renders —
 *  falling back to the raw key — so a parameter added at central before this map is updated is
 *  visible rather than dropped. */
const PARAM_META: Record<string, { label: string; help: string }> = {
  maxPolicyAgeMs: {
    label: "Max policy age",
    help: "How long a partitioned node keeps enforcing a replica it cannot refresh.",
  },
  policyPollIntervalMs: {
    label: "Policy poll interval",
    help: "How quickly a revocation reaches a node when the live channel is down.",
  },
  allowPause: {
    label: "Enforcement pause allowed",
    help: "Whether a node may pause denials to debug at all.",
  },
  pauseMaxMs: { label: "Max pause", help: "The longest a node may pause enforcement." },
  pauseDefaultMs: {
    label: "Default pause",
    help: "How long a pause lasts when none is specified.",
  },
  pauseTiers: { label: "Pausable tiers", help: "Which risk tiers a pause may ever cover." },
  leaseMaxMs: {
    label: "Max grace lease",
    help: "The longest a maintenance grace lease may soften faults.",
  },
  leaseTiers: { label: "Leasable tiers", help: "Which risk tiers a grace lease may cover." },
  maxTier: { label: "Max risk tier", help: "The most dangerous tier a node may host at all." },
  capabilityAllowlist: {
    label: "Capability allowlist",
    help: "If set, the only capabilities a node may use.",
  },
};

/** What a node profile is allowed to do to each dial — the merge direction, in words. */
const DIRECTION_NOTE: Record<SettingsParameter["direction"], string> = {
  lower: "a profile may only lower it",
  higher: "a profile may only raise it",
  subset: "a profile may only narrow the list",
  false: "a profile may only switch it off",
  tier: "a profile may only lower the ceiling",
};

function minutes(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = ms / 60_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}

/** A parameter value drawn for a human. `null` is not a blank: for a ceiling it means "no ceiling",
 *  for the allowlist it means "every capability" — different claims that must not both read as "—". */
function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) {
    if (key === "maxTier") return "no ceiling";
    if (key === "capabilityAllowlist") return "all capabilities";
    return "—";
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (typeof value === "number") return key.endsWith("Ms") ? minutes(value) : String(value);
  return String(value);
}

export function FleetSettingsPage() {
  const { data, loading, error } = useFetch(() => fleet.settings(), []);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>
            Central's own configuration — its deployment posture, and the fleet-wide policy
            parameters it distributes to every node. This is a read-only view: the parameters below
            are tightened by <strong>node profiles</strong>, edited through the policy API, and the
            machine-local jobs the old node "Config" menu did are commands now
            (<code>npm run providers:install</code>).
          </p>
        </div>
      </div>

      {error && <div className="error-banner">Could not load settings: {error}</div>}
      {loading && <div className="loading">Reading central's configuration…</div>}

      {data && (
        <>
          <div className="stat-grid">
            <StatTile
              label="Policy mode"
              value={data.mode === "authority" ? "Authority" : "Shadow"}
              sub={
                data.mode === "authority"
                  ? "central owns the policy tables"
                  : "nodes are still the writers"
              }
            />
            <StatTile
              label="Client authentication"
              value={data.security.mtls ? "mTLS enforced" : "Insecure loopback"}
              sub={
                data.security.mtls
                  ? "every fleet route requires a certificate"
                  : "WINDROW_CENTRAL_ALLOW_INSECURE is on — developer mode"
              }
            />
            <StatTile
              label="Node profiles"
              value={count(data.profiles.length)}
              sub={`${data.parameters.length} policy parameters they may narrow`}
            />
            <StatTile
              label="Rows in a default partition"
              value={count(data.storage.defaultPartitionRows)}
              sub={
                data.storage.defaultPartitionRows === 0
                  ? "as it should be — maintenance is running"
                  : "partition maintenance has lapsed"
              }
            />
          </div>

          {!data.security.mtls && (
            <div className="error-banner">
              Client-certificate enforcement is off — <code>WINDROW_CENTRAL_ALLOW_INSECURE=1</code>{" "}
              admits unauthenticated loopback callers. This is a developer affordance and should
              never be set on a real deployment.
            </div>
          )}

          <div className="card">
            <h2>Fleet policy parameters</h2>
            <p className="muted">
              The dials that decide whether governance holds, distributed to every node on the same
              signed channel as the deny-list. The value shown is the fleet-wide baseline a node with
              no profile uses; a profile may only make each one <em>more</em> restrictive.
            </p>
            <table>
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Fleet default</th>
                  <th>Environment variable</th>
                  <th>A profile may…</th>
                </tr>
              </thead>
              <tbody>
                {data.parameters.map((p) => {
                  const meta = PARAM_META[p.key];
                  return (
                    <tr key={p.key}>
                      <td>
                        {meta?.label ?? p.key}
                        {meta && <div className="muted">{meta.help}</div>}
                      </td>
                      <td className="tabular">{formatValue(p.key, p.fallback)}</td>
                      <td className="muted">
                        <code>WINDROW_{p.env}</code>
                      </td>
                      <td className="muted">{DIRECTION_NOTE[p.direction]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>Node profiles</h2>
            {data.profiles.length === 0 ? (
              <div className="empty-state">
                No node profiles yet. A profile is a class label with a narrowing ceiling — "the
                laptop may not host destructive", "the deploy MCP only on ci". Create one with{" "}
                <code>PUT /api/policy/node-profiles/&lt;name&gt;</code>, then re-enrol a node into it.
                Until then every node uses the fleet defaults above.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Profile</th>
                    <th>Nodes</th>
                    <th>Ceiling</th>
                  </tr>
                </thead>
                <tbody>
                  {data.profiles.map((profile) => {
                    const dials = Object.entries(profile.config);
                    return (
                      <tr key={profile.name}>
                        <td>
                          <code>{profile.name}</code>
                          {profile.description && (
                            <div className="muted">{profile.description}</div>
                          )}
                        </td>
                        <td className="tabular">{count(profile.nodeCount)}</td>
                        <td>
                          {dials.length === 0 ? (
                            <span className="muted">no ceiling — a label only</span>
                          ) : (
                            <div className="badge-row">
                              {dials.map(([key, value]) => (
                                <span key={key} className="badge">
                                  {PARAM_META[key]?.label ?? key}: {formatValue(key, value)}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
