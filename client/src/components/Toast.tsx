import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A viewport-anchored toast surface for ACTION outcomes — the grant that was revoked, the approval
 * that failed. It exists because the pages' `error-banner` sits at the top of the page, and an
 * action fired from a card the user scrolled down to would set that banner where they can't see it:
 * the failure was silent. A toast is `position: fixed`, so it lands in view no matter where the
 * scroll is, and outlives the row it came from (a revoke that removes its own card still gets to
 * report whether it worked).
 */

export type ToastTone = "error" | "success";

type Toast = { id: number; message: string; tone: ToastTone };

type ToastApi = {
  /** Push a toast. Errors persist until dismissed; successes auto-dismiss after a few seconds. */
  showToast: (message: string, tone?: ToastTone) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

// Errors stay until the user dismisses them — a failure that vanishes on its own is the silence
// this component exists to end. Successes are confirmation, not something to act on, so they clear.
const AUTO_DISMISS_MS: Record<ToastTone, number | null> = {
  error: null,
  success: 4000,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, tone: ToastTone = "error") => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, tone }]);
      const ttl = AUTO_DISMISS_MS[tone];
      if (ttl !== null) window.setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toast-portal" aria-live="assertive" aria-atomic="false">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
              <span className="toast-message">{t.message}</span>
              <button
                type="button"
                className="toast-dismiss"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
