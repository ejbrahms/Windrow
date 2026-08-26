/**
 * WHICH HOST IS SERVING THIS BUNDLE — the runtime half of docs/design/dashboard-placement.md
 * item 4, and the thing that keeps "one artifact" from meaning "one artifact that 404s".
 *
 * There is now exactly one dashboard and central serves it (server/central/routes.js's static
 * mount). But the same `client/dist` can still be reached against a node: a stale bookmark, a
 * `vite dev` proxied at :4443, a container someone kept. The node answers `/api/fleet/*` with a
 * 404 and central answers `/api/capabilities` with a 404, so a bundle that assumed either would
 * present a full navigation of buttons that fail — and a button that 404s teaches its reader
 * nothing, where a page that says "open this on the node" teaches them the whole architecture.
 *
 * THE PROBE IS THREE QUESTIONS, cheapest and most decisive first, and every one of them is a
 * route that already existed for another reason — nothing here asked either server for a new
 * endpoint:
 *
 *   1. `GET /health`     central only, and NOT under /api. `{ok, mode, defaultPartitionRows}`.
 *   2. `GET /api/ready`  the node's readiness, which central has no route for at all.
 *   3. `GET /api/fleet/hooks` — the tie-breaker for the one case the first two miss.
 *
 * WHY THE THIRD EXISTS. `vite dev` proxies `/api` and nothing else (client/vite.config.ts), so
 * `/health` in development hits Vite itself and comes back as the SPA's own index.html — a 200
 * that is not JSON. Question 1 therefore cannot be a status check; it has to parse the body and
 * look for a field only central sends. And a dev server pointed at central would then fail 1 (not
 * proxied) and fail 2 (no such route), which is what question 3 is for: an admin-scoped fleet
 * route that a node has never heard of. A 401 or 403 from it still answers the question — the
 * route EXISTS, so this is central and the browser simply has no admin certificate.
 *
 * A FAILED PROBE IS "unknown", AND UNKNOWN IS PERMISSIVE. Hiding the whole navigation because a
 * fetch was interrupted would be a worse failure than showing a page that turns out to 404: the
 * first looks like the app is broken, the second looks like the route is missing, and only one of
 * those is true. See ../hooks/useHost.tsx, which is where that policy is applied.
 */

export type HostKind = "central" | "node" | "unknown";

export interface HostIdentity {
  kind: HostKind;
  /** Central's own word for which phase its schema is in: 'authority' once it holds the policy
   *  tables, 'shadow' while the nodes are still the writers. Null on a node, and null on a central
   *  whose `/health` came back 503 because it could not reach Postgres. */
  mode: string | null;
  /** Rows stranded in `usage_events_default`, straight off `/health`. Should be zero forever; a
   *  non-zero here means partition maintenance lapsed, which is a fact worth carrying into the
   *  chrome rather than leaving on one page. */
  defaultPartitionRows: number | null;
  /** True only when central is the public read-only demo (WINDROW_CENTRAL_DEMO_READONLY=1, reported
   *  on /health). Gates demo-only surfaces like the Sandbox: a real fleet console never shows them,
   *  and a node — which has no /health `demo` field — is false here for the same reason. */
  demo: boolean;
  /** Why the answer is what it is, in one line — shown on the page that explains itself. */
  detail: string;
}

/** A fetch that never throws and never hangs: every branch below wants "what came back, if
 *  anything", and a probe that rejects would make the ladder read as error handling rather than
 *  as three questions. */
async function probe(path: string, timeoutMs = 4000): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { signal: controller.signal, headers: { Accept: "application/json" } });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON — a dev server's index.html, or an HTML error page from something in front.
    }
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function field(body: unknown, key: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

export async function detectHost(): Promise<HostIdentity> {
  // 1. Central's liveness. Parsed rather than status-checked, for the Vite reason in the header —
  //    and accepted on 503 too, because a central that cannot reach Postgres is still central and
  //    hiding the fleet pages from it would hide the one view that would explain the outage.
  const health = await probe("/health");
  if (health && (health.status === 200 || health.status === 503) && typeof field(health.body, "ok") === "boolean") {
    const mode = field(health.body, "mode");
    const stranded = field(health.body, "defaultPartitionRows");
    return {
      kind: "central",
      mode: typeof mode === "string" ? mode : null,
      defaultPartitionRows: typeof stranded === "number" ? stranded : null,
      demo: field(health.body, "demo") === true,
      detail:
        health.status === 503
          ? "central answered /health, but it cannot reach its database right now"
          : `central answered /health${typeof mode === "string" ? ` in ${mode} mode` : ""}`,
    };
  }

  // 2. The node's readiness. `ready: false` is still a node — a cold node that has never completed
  //    a policy pull reports 503 here on purpose (item 8), and that is the state where someone most
  //    wants the machine-local pages, not least.
  const ready = await probe("/api/ready");
  if (ready && (ready.status === 200 || ready.status === 503) && (typeof field(ready.body, "ready") === "boolean" || field(ready.body, "contract") !== undefined)) {
    return {
      kind: "node",
      mode: null,
      defaultPartitionRows: null,
      demo: false,
      detail: field(ready.body, "ready") === false
        ? "a node answered /api/ready, and it is not ready yet"
        : "a node answered /api/ready",
    };
  }

  // 3. The tie-breaker: an admin-scoped fleet route a node has never heard of. Anything but a 404
  //    means the route is mounted, so this is central; 401/403 additionally says the browser holds
  //    no admin certificate, which is worth carrying into the notice the user will see.
  const hooks = await probe("/api/fleet/hooks");
  if (hooks && hooks.status !== 404) {
    const unauthorized = hooks.status === 401 || hooks.status === 403;
    return {
      kind: "central",
      mode: null,
      defaultPartitionRows: null,
      // This branch is reached only when /health did not answer (a dev server proxying /api, most
      // often), so the demo flag it carries was never seen. Default false: the public demo answers
      // /health directly and takes the first branch, so a "true" could only be a guess here.
      demo: false,
      detail: unauthorized
        ? "central is serving this page, but this browser has no admin client certificate"
        : "central is serving this page — /api/fleet answered",
    };
  }

  return {
    kind: "unknown",
    mode: null,
    defaultPartitionRows: null,
    demo: false,
    detail: "neither /health nor /api/ready answered — showing every page rather than guessing",
  };
}
