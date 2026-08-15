import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

// Whether the first-run setup wizard (OnboardingWizard) has been shown to this browser before.
// Persisted client-side only — there's no server concept of "onboarded", so a fresh browser (or a
// cleared localStorage) always sees it again even against a fully-configured backend.
const STORAGE_KEY = "cg-onboarded";

function getStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

interface OnboardingContextValue {
  // Whether the wizard overlay is currently rendered.
  visible: boolean;
  // Whether setup has been completed or explicitly skipped at least once.
  completed: boolean;
  // Re-opens the wizard on demand (e.g. a "Setup guide" link in the nav) — does not reset
  // `completed`, so finishing again just re-marks it, not un-does it.
  open: () => void;
  // Dismiss without marking as done — used for the backdrop/Esc, not a real onboarding action.
  close: () => void;
  // Mark onboarding done (via "Finish" or "Skip setup" — both count) and hide the wizard.
  finish: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [completed, setCompleted] = useState(getStored);
  const [visible, setVisible] = useState(() => !getStored());

  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  const finish = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore write failures (private browsing, etc.)
    }
    setCompleted(true);
    setVisible(false);
  }, []);

  return (
    <OnboardingContext.Provider value={{ visible, completed, open, close, finish }}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error("useOnboarding must be used within an OnboardingProvider");
  return ctx;
}
