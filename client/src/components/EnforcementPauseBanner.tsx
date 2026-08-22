import { useEnforcementPause, usePauseCountdown } from "../hooks/useEnforcementPause";

const TIER_LABEL: Record<string, string> = {
  read_only: "read-only",
  mutating: "mutating",
  destructive: "destructive",
};

/**
 * The "enforcement is off right now" banner, rendered in the app chrome above every page
 * (docs/design/enforcement-pause.md).
 *
 * WHY IT IS IN THE CHROME AND NOT ON A PAGE. A pause is invisible by construction: nothing fails
 * while it is on, so the only evidence is a call that should have been denied and was not, which
 * nobody notices. Server-side the window is announced on a 60-second log heartbeat, but nobody is
 * tailing that. This is the thing that stops someone debugging for twenty minutes inside a window
 * they opened and forgot — so it follows them across every page rather than living on the one page
 * they would have to go back to.
 *
 * It renders nothing at all in the normal case, which is the overwhelming majority of the time.
 */
export function EnforcementPauseBanner() {
  const { pause, end } = useEnforcementPause();
  const countdown = usePauseCountdown(pause);

  // `countdown` going null is the window lapsing between polls — drop the banner immediately rather
  // than leaving it up until the next fetch confirms what the clock already knows.
  if (!pause || !countdown) return null;

  const tiers = pause.tolerate.map((t) => TIER_LABEL[t] ?? t).join(", ");

  return (
    <div className="enforcement-banner" role="status">
      <svg
        className="enforcement-banner-icon"
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3.5 5 6.3v5.4c0 4.4 2.9 7.6 7 8.8 4.1-1.2 7-4.4 7-8.8V6.3L12 3.5Z" />
        <path d="M9 9.5l6 5M15 9.5l-6 5" />
      </svg>
      <span className="enforcement-banner-text">
        <strong>Denials are switched off</strong> for {tiers} capabilities — a call with no grant is
        being allowed and logged.
        {pause.reason ? <> Reason: “{pause.reason}”.</> : null}
        {pause.issuedBy ? <> Opened by {pause.issuedBy}.</> : null}
      </span>
      <span className="enforcement-banner-clock" title="Enforcement resumes on its own when this reaches zero">
        {countdown}
      </span>
      <button type="button" className="btn enforcement-banner-btn" onClick={() => void end()}>
        Resume now
      </button>
    </div>
  );
}
