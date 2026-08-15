export function WelcomeStep() {
  return (
    <div className="onboarding-step">
      <h2>Welcome to Capability Governance</h2>
      <p>
        This is the control plane for what agents on this field are allowed to do. Before anything
        shows up in the catalog or the dashboard, a few things need to be wired up:
      </p>
      <ul className="onboarding-checklist">
        <li>
          <strong>Providers</strong> — which agent backends (Claude Code, Codex, …) get the
          PreToolUse/PostToolUse hooks that actually enforce grants.
        </li>
        <li>
          <strong>Discovery sources</strong> — which directories to scan for skills so they show
          up in the catalog automatically.
        </li>
        <li>
          <strong>A first scan</strong> — populate the catalog from whatever those sources find.
        </li>
      </ul>
      <p className="muted" style={{ fontSize: 12 }}>
        Every step here can also be revisited later from the Providers and Sources pages — nothing
        this wizard sets up is one-way.
      </p>
    </div>
  );
}
