import { api } from "../api/client";
import { useFetch } from "../api/useFetch";
import { InvokePanel } from "../components/InvokePanel";

/**
 * Fire a real /api/invoke call and watch the broker allow or deny it live.
 *
 * Under Config rather than on the Overview: this writes a usage event, so leaving it at the foot
 * of a page people leave open all day meant the dashboard could nudge its own numbers. It's a
 * setup-and-verification tool — "did I wire this grant up right" — which is what Config is for.
 */
export function InvokeDemoPage() {
  const { data: principals } = useFetch(() => api.principals.list(), []);
  const { data: capabilities } = useFetch(() => api.capabilities.list(), []);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Invoke demo</h1>
          <p>
            Fire a real grant check against the broker and see the decision it returns. This
            records a usage event like any other call, so it will show up on the Overview.
          </p>
        </div>
      </div>

      <InvokePanel principals={principals ?? []} capabilities={capabilities ?? []} />
    </div>
  );
}
