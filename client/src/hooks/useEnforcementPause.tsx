import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { EnforcementPause, EnforcementPauseRequest } from "../api/types";

// The enforcement pause, shared between the banner in the app chrome and the control on the Hook
// Integrity page (docs/design/enforcement-pause.md).
//
// A context rather than two independent useFetch calls, for one reason that matters: opening a
// window from the control must make the banner appear AT ONCE. A pause is invisible by
// construction — nothing fails while it is on — so the banner is the only thing standing between
// an operator and twenty minutes of debugging inside a window they have forgotten about. A banner
// that takes a poll interval to notice is a banner that is missing exactly when it is most needed.
//
// WHY IT POLLS AT ALL, given the control already refreshes it: a pause is time-boxed and expires on
// its own, and it can be opened from three other places this browser never sees — the CLI
// (`npm run denials:off`), the API directly, and `WINDROW_DISABLE_DENIALS` at server startup. A
// dashboard left open on a second monitor has to find out about those, and has to notice the
// window closing itself.

const POLL_MS = 15_000;

interface EnforcementPauseContextValue {
  /** The live window, or null when denials are being enforced normally. */
  pause: EnforcementPause | null;
  loading: boolean;
  /** A load failure. Null while it is merely absent — "no pause" is the normal state, not an error. */
  error: string | null;
  /**
   * True when the server refused to say (401/403), i.e. this browser holds no credential the API
   * accepts. Kept apart from `error` so the UI can hide the control rather than show a red box: a
   * dashboard loaded over the plaintext listener cannot authenticate at all
   * (docs/design/per-node-enrollment-credentials.md), and that is a deployment fact, not a fault.
   */
  unauthorized: boolean;
  reload: () => void;
  begin: (body: EnforcementPauseRequest) => Promise<EnforcementPause>;
  end: () => Promise<void>;
}

const EnforcementPauseContext = createContext<EnforcementPauseContextValue | null>(null);

export function EnforcementPauseProvider({ children }: { children: ReactNode }) {
  const [pause, setPause] = useState<EnforcementPause | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.enforcement
        .get()
        .then((next) => {
          if (cancelled) return;
          setPause(next);
          setError(null);
          setUnauthorized(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const status = err instanceof ApiError ? err.status : 0;
          if (status === 401 || status === 403) {
            // Not a fault: this browser simply holds no credential the API accepts.
            setUnauthorized(true);
            setPause(null);
            setError(null);
          } else {
            setError(err instanceof Error ? err.message : String(err));
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tick]);

  const begin = useCallback(async (body: EnforcementPauseRequest) => {
    const next = await api.enforcement.pause(body);
    // Set it straight from the response rather than re-fetching: the banner should be up before the
    // next paint, not after another round trip.
    setPause(next);
    setUnauthorized(false);
    return next;
  }, []);

  const end = useCallback(async () => {
    await api.enforcement.resume();
    setPause(null);
  }, []);

  return (
    <EnforcementPauseContext.Provider
      value={{ pause, loading, error, unauthorized, reload, begin, end }}
    >
      {children}
    </EnforcementPauseContext.Provider>
  );
}

export function useEnforcementPause(): EnforcementPauseContextValue {
  const ctx = useContext(EnforcementPauseContext);
  if (!ctx) throw new Error("useEnforcementPause must be used inside an EnforcementPauseProvider");
  return ctx;
}

/**
 * A live countdown against the pause's own `until`, re-rendering once a second.
 *
 * Deliberately driven by `until` (an absolute server timestamp) rather than by decrementing
 * `remainingMs`: a browser tab that was backgrounded, or a laptop that slept, would otherwise wake
 * up showing time that has already passed — on a control whose entire job is to say how much longer
 * enforcement is off.
 *
 * Returns null once the window has lapsed, which is what makes the banner disappear on its own
 * rather than sitting at "0m" until the next poll.
 */
export function usePauseCountdown(pause: EnforcementPause | null): string | null {
  const [, force] = useState(0);

  useEffect(() => {
    if (!pause) return;
    const timer = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [pause]);

  if (!pause) return null;
  const remaining = pause.until - Date.now();
  if (remaining <= 0) return null;
  const totalSeconds = Math.ceil(remaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
