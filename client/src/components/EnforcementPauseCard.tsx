import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { useEnforcementPause, usePauseCountdown } from "../hooks/useEnforcementPause";
import type { RiskTierName } from "../api/types";

// The server clamps every window into [5m, 30m] regardless of what is asked for
// (server/enforcementPause.js), so these are the whole range rather than a convenient subset.
const DURATIONS = ["5m", "10m", "15m", "20m", "30m"];
const DEFAULT_DURATION = "15m";

// `destructive` is deliberately unchecked by default and separated below. The server applies the
// same rule — a pause only ever covers it when named explicitly — so this mirrors the policy rather
// than inventing a client-side one.
const TIERS: { value: RiskTierName; label: string; note: string }[] = [
  { value: "read_only", label: "Read-only", note: "reads, lookups, listings" },
  { value: "mutating", label: "Mutating", note: "writes and edits" },
  { value: "destructive", label: "Destructive", note: "deletes and irreversible calls" },
];

/**
 * The enforcement-pause control (docs/design/enforcement-pause.md).
 *
 * Lives on the Hook Integrity page because that page already answers "is governance still wired
 * up?", and this is the same question from the other side: whether it is deliberately switched off
 * right now. The banner in the app chrome is what makes an open window impossible to forget; this
 * is where one is opened and closed.
 *
 * Opening one is behind a confirm dialog, and the dialog names the tiers rather than saying
 * "continue?" — the difference between a window covering reads and one covering deletes is the
 * whole risk, and it should not be something you find out afterwards from the banner.
 */
export function EnforcementPauseCard() {
  const { pause, loading, error, unauthorized, begin, end } = useEnforcementPause();
  const countdown = usePauseCountdown(pause);

  const [duration, setDuration] = useState(DEFAULT_DURATION);
  const [reason, setReason] = useState("");
  const [tiers, setTiers] = useState<RiskTierName[]>(["read_only", "mutating"]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // A browser with no credential the API accepts can't work this control, and showing it a form
  // that 403s on submit is worse than not showing the form. See the hook for why this is not an
  // error state.
  if (unauthorized) return null;

  const toggleTier = (tier: RiskTierName) => {
    setTiers((current) =>
      current.includes(tier) ? current.filter((t) => t !== tier) : [...current, tier]
    );
  };

  const submit = async () => {
    setConfirming(false);
    setBusy(true);
    setActionError(null);
    try {
      await begin({ duration, reason: reason.trim() || undefined, tolerate: tiers });
      setReason("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await end();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const active = pause && countdown;

  return (
    <div className={"card enforcement-card" + (active ? " paused" : "")}>
      <h2>
        Enforcement
        <span className="muted">
          {active ? "denials are suppressed right now" : "denials are being enforced"}
        </span>
      </h2>

      {error && <div className="error-banner">Could not read enforcement state: {error}</div>}
      {actionError && <div className="error-banner">{actionError}</div>}

      {active ? (
        <div className="enforcement-active">
          <p>
            Denials on <strong>{pause.tolerate.map((t) => t.replace("_", "-")).join(", ")}</strong>{" "}
            capabilities are suppressed for another <strong>{countdown}</strong>. A call with no
            grant is being allowed, and every one of them is written to{" "}
            <code>server/data/hook-fault-journal.jsonl</code> with this window's id (
            <code>{pause.id}</code>) on it.
          </p>
          <p className="muted">
            {pause.reason ? <>Reason: “{pause.reason}”. </> : null}
            {pause.issuedBy ? <>Opened by {pause.issuedBy}. </> : null}
            Revocations and direct shell access to the governance API still deny. Enforcement
            resumes on its own when the clock runs out — nothing needs to be done.
          </p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => void resume()} disabled={busy}>
              Resume enforcement now
            </button>
          </div>
        </div>
      ) : (
        <div className="enforcement-form">
          <p>
            Turn denials off for a bounded window so a debugging session isn't fighting enforcement
            as a second variable. The window is signed by this server, capped at 30 minutes, and
            expires on its own.
          </p>

          <div className="enforcement-row">
            <label htmlFor="enforcement-duration">For</label>
            <select
              id="enforcement-duration"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              disabled={busy || loading}
            >
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d.replace("m", " minutes")}
                </option>
              ))}
            </select>
          </div>

          <div className="enforcement-row">
            <label htmlFor="enforcement-reason">Reason</label>
            <input
              id="enforcement-reason"
              type="text"
              placeholder="what you're debugging — goes on every audit row"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy || loading}
              maxLength={200}
            />
          </div>

          <fieldset className="enforcement-tiers">
            <legend>Covering</legend>
            {TIERS.map((tier) => (
              <label
                key={tier.value}
                className={"enforcement-tier" + (tier.value === "destructive" ? " destructive" : "")}
              >
                <input
                  type="checkbox"
                  checked={tiers.includes(tier.value)}
                  onChange={() => toggleTier(tier.value)}
                  disabled={busy || loading}
                />
                <span>
                  {tier.label} <span className="muted">— {tier.note}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="actions">
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => setConfirming(true)}
              disabled={busy || loading || tiers.length === 0}
              title={tiers.length === 0 ? "Pick at least one tier" : undefined}
            >
              Turn off denials
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Turn off denials?"
          message={
            `For the next ${duration.replace("m", " minutes")}, calls with no grant will be ALLOWED on ` +
            `${tiers.map((t) => t.replace("_", "-")).join(", ")} capabilities` +
            `${tiers.includes("destructive") ? ", including deletes and other irreversible calls" : ""}. ` +
            "Every one is logged with this window's id, and enforcement resumes on its own."
          }
          confirmLabel="Turn off denials"
          danger
          onConfirm={() => void submit()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
