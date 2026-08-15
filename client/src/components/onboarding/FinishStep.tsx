export function FinishStep() {
  return (
    <div className="onboarding-step">
      <h2>You're set up</h2>
      <p>
        Providers, discovery sources, and an initial scan are all in place (or intentionally
        skipped — that's fine too). From here:
      </p>
      <ul className="onboarding-checklist">
        <li>
          <strong>Catalog</strong> — browse what discovery found and what's registered manually.
        </li>
        <li>
          <strong>Grants</strong> — decide which principals get which capabilities.
        </li>
        <li>
          <strong>Dashboard</strong> — watch real usage and denials once agents start calling in.
        </li>
      </ul>
      <p className="muted" style={{ fontSize: 12 }}>
        This guide is always one click away from the nav bar if you want to revisit a step.
      </p>
    </div>
  );
}
