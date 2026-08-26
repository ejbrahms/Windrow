import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { detectHost } from "../api/host";
import type { HostIdentity, HostKind } from "../api/host";

/**
 * Detected ONCE, at the top of the app, and shared — the nav, the router and every page ask the
 * same question and none of them should ask it over the network. See ../api/host.ts for what the
 * probe actually does and why it takes three questions.
 *
 * WHICH PAGES A HOST CAN SERVE is expressed as a scope on each route rather than as a check
 * inside each page. There are three:
 *
 *   "node"     a machine-local route — capabilities, grants, principals, discovery, providers,
 *              skills, hook installation, the enforcement pause, invoke. Central mounts none of
 *              these and never will: they are about one machine's disk and one machine's config.
 *   "central"  a `/api/fleet/*` route. A node mounts none of them; it has no fleet to report on.
 *   "any"      needs no API at all (Docs), or is served by both under different endpoints.
 *   "demo"     the public read-only demo ONLY — the Sandbox and other visitor-facing toys that teach
 *              the product but have no place on a real fleet's console. Unlike the others this scope
 *              is STRICT, not permissive on an unknown host: a route that must not appear on a real
 *              deployment is better hidden on a failed probe than shown, so it renders only when the
 *              host is confirmed to be the demo.
 */
export type PageScope = "node" | "central" | "any" | "demo";

interface HostState {
  host: HostIdentity | null;
  loading: boolean;
  /** Whether a page of this scope can work on the host that is actually serving us. UNKNOWN IS
   *  PERMISSIVE: a probe that could not complete must not blank the navigation, because "the app
   *  is broken" is a worse and less true message than "that route is not on this host". */
  allows: (scope: PageScope) => boolean;
}

const HostContext = createContext<HostState>({
  host: null,
  loading: true,
  allows: () => true,
});

export function HostProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HostIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    detectHost()
      .then((identity) => {
        if (!cancelled) setHost(identity);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<HostState>(() => {
    const kind: HostKind = host?.kind ?? "unknown";
    return {
      host,
      loading,
      allows: (scope) => {
        if (scope === "any") return true;
        // Strict, and before the permissive-unknown rule below: a demo-only surface must never show
        // on a real deployment, so it needs a confirmed demo host, not the benefit of the doubt.
        if (scope === "demo") return host?.demo === true;
        if (kind === "unknown") return true;
        return kind === scope;
      },
    };
  }, [host, loading]);

  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

export function useHost(): HostState {
  return useContext(HostContext);
}
