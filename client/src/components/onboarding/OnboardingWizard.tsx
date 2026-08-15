import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useOnboarding } from "../../hooks/useOnboarding";
import { WelcomeStep } from "./WelcomeStep";
import { ProvidersStep } from "./ProvidersStep";
import { SourcesStep } from "./SourcesStep";
import { DiscoveryStep } from "./DiscoveryStep";
import { FinishStep } from "./FinishStep";

const STEPS = [
  { key: "welcome", label: "Welcome", render: () => <WelcomeStep /> },
  { key: "providers", label: "Providers", render: () => <ProvidersStep /> },
  { key: "sources", label: "Sources", render: () => <SourcesStep /> },
  { key: "discovery", label: "First scan", render: () => <DiscoveryStep /> },
  { key: "finish", label: "Done", render: () => <FinishStep /> },
];

/**
 * First-run setup wizard — shown once per browser (see useOnboarding) and reachable afterward via
 * the "Setup guide" link in the nav. Every task it walks through (installing provider hooks,
 * configuring discovery sources, running the first scan) is just the existing Providers/Sources/
 * Catalog page flows condensed into steps; nothing here is wizard-only functionality.
 */
export function OnboardingWizard() {
  const { close, finish } = useOnboarding();
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);

  const step = STEPS[index];
  const isFirst = index === 0;
  const isLast = index === STEPS.length - 1;

  function goTo(path: string) {
    finish();
    navigate(path);
  }

  return (
    <div className="onboarding-backdrop" role="presentation">
      <div className="onboarding-dialog" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="onboarding-header">
          <div className="onboarding-progress">
            {STEPS.map((s, i) => (
              <div
                key={s.key}
                className={`onboarding-dot ${i === index ? "active" : ""} ${i < index ? "done" : ""}`}
                title={s.label}
              />
            ))}
          </div>
          <button className="onboarding-close" aria-label="Skip setup" onClick={finish}>
            Skip setup
          </button>
        </div>

        <div id="onboarding-title" className="onboarding-body">
          {step.render()}
        </div>

        <div className="onboarding-footer">
          <button className="btn" onClick={close} style={{ marginRight: "auto" }}>
            Close
          </button>
          {!isFirst && (
            <button className="btn" onClick={() => setIndex((i) => Math.max(0, i - 1))}>
              Back
            </button>
          )}
          {!isLast && (
            <button className="btn btn-primary" onClick={() => setIndex((i) => Math.min(STEPS.length - 1, i + 1))}>
              Next
            </button>
          )}
          {isLast && (
            <>
              <button className="btn" onClick={() => goTo("/catalog")}>
                Go to catalog
              </button>
              <button className="btn btn-primary" onClick={() => goTo("/dashboard")}>
                Go to dashboard
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
