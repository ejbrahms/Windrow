import { num } from "../../api/fleet";
import type { CredentialState, HookStatus, Numeric } from "../../api/fleet";

/**
 * The handful of formatters and badges every fleet page needs, in one place rather than ten.
 *
 * The existing pages each keep their own little `pct`/`sinceLabel` helper, and at one or two
 * copies that is the right call — a local helper is cheaper to read than an import. At ten it
 * stops being: the fleet pages all render the same four things (a count, an age, a byte size, a
 * hook status), and ten hand-written copies of "how old is this" is ten chances for two pages to
 * disagree about whether 90 seconds is "1m ago" or "90s ago" on the same screen.
 */

/**
 * An array central may not have sent — §2.6's rule, applied on this side of the wire.
 *
 * NOT DEFENSIVE PROGRAMMING FOR ITS OWN SAKE. These pages are one bundle served by whichever
 * central is running, and a central is upgraded on its own schedule: `verify` grew `heads[]` and
 * `storage` grew `tables` with docs/design/dashboard-placement.md items 1 and 5, so a browser
 * holding the new bundle against a central that predates them reads `undefined`. Measured here
 * against the live central on this machine, `v.heads.length` threw and React unmounted the whole
 * route — a blank page, which tells its reader nothing at all, in place of a table with one
 * column missing.
 */
export function list<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : [];
}

/** A count, or an em dash. Never "0" for a value that was not recorded — those are different
 *  claims, and on a governance dashboard the difference is the whole point. */
export function count(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}

export function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`;
}

export function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/**
 * "just now" / "12s ago" / "3d ago" — the only question anyone has of a fleet page is how stale
 * what they are looking at is.
 *
 * Takes a millisecond age rather than a timestamp because central computes several of these
 * itself (`silentForMs`, `reportAgeMs`) against ITS clock, and recomputing them against the
 * browser's would reintroduce exactly the skew §2.3 exists to keep out of the numbers.
 *
 * AND IT COERCES, because those two arrive as STRINGS. `EXTRACT(EPOCH FROM …)` is `numeric` in
 * Postgres, and server/central/pgDriver.js parses only BIGINT — so `silentForMs` comes over the
 * wire as `"1970365.000000"`. Measured against the live central here: typed as a number and
 * checked with `Number.isFinite`, every roster row read "never seen", which is the most alarming
 * possible way for a formatter to be wrong.
 */
export function age(ms: Numeric | undefined): string {
  const value = num(ms);
  if (value === null) return "never";
  const seconds = Math.max(0, Math.round(value / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** An incarnation id is a long opaque string; on a roster row only its tail distinguishes one
 *  lifetime from the next, and the full value is one hover away. */
export function shortId(id: string | null | undefined, keep = 10): string {
  if (!id) return "—";
  return id.length <= keep ? id : `…${id.slice(-keep)}`;
}

const HOOK_LABEL: Record<HookStatus, string> = {
  installed: "Installed",
  tampered: "Tampered",
  missing: "Missing",
  unknown: "Never reported",
};

// 'unknown' is drawn as a warning rather than as a fourth neutral state, and that is the one
// judgement call in this file. A node that has never reported its hook wiring is not "fine, no
// data" — on a check whose subject is *has governance been switched off on that machine*, silence
// and a clean bill of health must not look alike.
const HOOK_TONE: Record<HookStatus, string> = {
  installed: "badge-ok",
  tampered: "badge-denied",
  missing: "badge-denied",
  unknown: "badge-error",
};

export function HookStatusBadge({ status }: { status: HookStatus | null | undefined }) {
  const value: HookStatus = status ?? "unknown";
  return <span className={`badge ${HOOK_TONE[value]}`}>{HOOK_LABEL[value]}</span>;
}

// Risk-tier labels, spelled exactly as the enforcement-pause banner spells them so a pause reads
// the same wherever it appears (see ../../components/EnforcementPauseBanner.tsx).
const TIER_LABEL: Record<string, string> = {
  read_only: "read-only",
  mutating: "mutating",
  destructive: "destructive",
};

/**
 * The comma-joined tier string central sends ("read_only,mutating") drawn as one badge per tier,
 * each in its own risk tone — green/amber/red, the same axis the catalog uses. It is a STRING, not
 * an array: central joins the tiers on the wire, so splitting it is this side's job. Null or empty
 * renders nothing rather than an em dash — the caller decides what "no tiers" should say.
 */
export function TierBadges({ tiers }: { tiers: string | null | undefined }) {
  const parts = (tiers ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((t) => (
        <span key={t} className={`badge badge-${t}`}>
          {TIER_LABEL[t] ?? t}
        </span>
      ))}
    </>
  );
}

const CREDENTIAL_LABEL: Record<CredentialState, string> = {
  valid: "Valid",
  expiring: "Expiring",
  expired: "Expired",
  absent: "Absent",
  unreadable: "Unreadable",
  "not-applicable": "n/a",
};

// The credential is a good/bad axis — §2.2's year fuse — so this runs green→amber→red. `expired`
// is the alarming end (a node that has silently fallen out of the fleet), the same critical tone a
// pause gets; `expiring`, `absent` and `unreadable` are the amber "look before it does".
const CREDENTIAL_TONE: Record<CredentialState, string> = {
  valid: "badge-ok",
  expiring: "badge-error",
  expired: "badge-denied",
  absent: "badge-error",
  unreadable: "badge-error",
  "not-applicable": "badge",
};

/** The node's leaf-certificate state as a badge. `not-applicable` — central never issued this node
 *  one — is an em dash rather than a badge, because it is the absence of the question, not an answer
 *  to it. */
export function CredentialBadge({ state }: { state: CredentialState | null | undefined }) {
  if (!state || state === "not-applicable") return <span className="muted">—</span>;
  return <span className={`badge ${CREDENTIAL_TONE[state]}`}>{CREDENTIAL_LABEL[state]}</span>;
}

/** The windows every fleet route takes as `?hours=`. Three, not a free-text box: the routes window
 *  on `observedAt`, the partition key, so these are the spans that prune rather than scan. */
export interface FleetWindow {
  key: string;
  label: string;
  hours: number;
}

export const FLEET_WINDOWS: FleetWindow[] = [
  { key: "1h", label: "Last hour", hours: 1 },
  { key: "24h", label: "Last 24 hours", hours: 24 },
  { key: "7d", label: "Last 7 days", hours: 168 },
  { key: "30d", label: "Last 30 days", hours: 720 },
];

export function WindowPicker({
  value,
  onChange,
  label = "Time range",
}: {
  value: FleetWindow;
  onChange: (next: FleetWindow) => void;
  label?: string;
}) {
  return (
    <div className="tabs" role="group" aria-label={label}>
      {FLEET_WINDOWS.map((w) => (
        <button
          key={w.key}
          type="button"
          className={"tab" + (value.key === w.key ? " active" : "")}
          aria-pressed={value.key === w.key}
          onClick={() => onChange(w)}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}
