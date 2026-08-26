import type { ReactNode } from "react";
import { Navigate, Route, HashRouter, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { HostGate } from "./components/HostGate";
import type { PageScope } from "./hooks/useHost";
import { useHost } from "./hooks/useHost";
import { CatalogPage } from "./pages/CatalogPage";
import { PrincipalsPage } from "./pages/PrincipalsPage";
import { GrantsPage } from "./pages/GrantsPage";
import { SkillsPage } from "./pages/SkillsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { DocsPage } from "./pages/DocsPage";
import { SourcesPage } from "./pages/SourcesPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { HookIntegrityPage } from "./pages/HookIntegrityPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { AgentOwnersPage } from "./pages/AgentOwnersPage";
import { DriftPage } from "./pages/DriftPage";
import { NativeCallsPage } from "./pages/NativeCallsPage";
import { InvokeDemoPage } from "./pages/InvokeDemoPage";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { FleetOverviewPage } from "./pages/fleet/FleetOverviewPage";
import { FleetNodesPage } from "./pages/fleet/FleetNodesPage";
import { FleetNodeDetailPage } from "./pages/fleet/FleetNodeDetailPage";
import { FleetEnforcementPage } from "./pages/fleet/FleetEnforcementPage";
import { FleetNodeJournalPage } from "./pages/fleet/NodeJournal";
import { FleetNativePage } from "./pages/fleet/FleetNativePage";
import { FleetUsagePage } from "./pages/fleet/FleetUsagePage";
import { FleetEventsPage } from "./pages/fleet/FleetEventsPage";
import { FleetAlertsPage } from "./pages/fleet/FleetAlertsPage";
import { FleetShadowPage } from "./pages/fleet/FleetShadowPage";
import { FleetIntegrationsPage } from "./pages/fleet/FleetIntegrationsPage";
import { FleetIntegrationDetailPage } from "./pages/fleet/FleetIntegrationDetailPage";
import { FleetSettingsPage } from "./pages/fleet/FleetSettingsPage";
import { PolicyCatalogPage } from "./pages/policy/PolicyCatalogPage";
import { PolicyPrincipalsPage } from "./pages/policy/PolicyPrincipalsPage";
import { PolicyGrantsPage } from "./pages/policy/PolicyGrantsPage";
import { PolicyApprovalsPage } from "./pages/policy/PolicyApprovalsPage";
import { OnboardingProvider, useOnboarding } from "./hooks/useOnboarding";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { EnforcementPauseProvider } from "./hooks/useEnforcementPause";
import { HostProvider } from "./hooks/useHost";

/**
 * EVERY ROUTE CARRIES THE HOST IT WORKS ON — docs/design/dashboard-placement.md item 4.
 *
 * There is one bundle and central serves it. A node mounts none of `/api/fleet/*`, and central
 * mounts none of the machine-local routes the older pages call, so a route rendered on the wrong
 * host is a page of controls that 404 with no explanation. `<HostGate>` renders the page where it
 * works and, where it does not, a short page saying which host it lives on and what to run
 * instead — "one artifact, and a page that says 'open this on the node' beats a button that
 * 404s".
 *
 * The scope is declared here, at the route, rather than inside each page: a page that checked for
 * itself would already have mounted and fired its fetches by the time it found out.
 */
function gate(scope: PageScope, title: string, element: ReactNode) {
  return (
    <HostGate scope={scope} title={title}>
      {element}
    </HostGate>
  );
}

export default function App() {
  return (
    // Outside the router: the enforcement-pause banner lives in the app chrome and has to survive
    // navigation, and the control on the Hook Integrity page shares this state so opening a window
    // puts the banner up at once rather than a poll interval later.
    //
    // HostProvider is outermost of the three because the other two ask API routes that only exist
    // on one of the hosts, and the nav inside Layout needs the answer before it draws a single link.
    <HostProvider>
    <EnforcementPauseProvider>
    <OnboardingProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />

            {/* Machine-local: one PC's disk, config files and enforcement switch. */}
            <Route path="/catalog" element={gate("node", "Catalog", <CatalogPage />)} />
            <Route path="/sources" element={gate("node", "Sources", <SourcesPage />)} />
            <Route path="/providers" element={gate("node", "Providers & integrations", <ProvidersPage />)} />
            <Route path="/hook-integrity" element={gate("node", "Hook integrity (this machine)", <HookIntegrityPage />)} />
            <Route path="/approvals" element={gate("node", "Approvals", <ApprovalsPage />)} />
            <Route path="/agent-owners" element={gate("node", "Agent owners", <AgentOwnersPage />)} />
            <Route path="/drift" element={gate("node", "Drift", <DriftPage />)} />
            <Route path="/invoke" element={gate("node", "Invoke demo", <InvokeDemoPage />)} />
            <Route path="/principals" element={gate("node", "Principals", <PrincipalsPage />)} />
            <Route path="/grants" element={gate("node", "Grants", <GrantsPage />)} />
            <Route path="/skills" element={gate("node", "Skills", <SkillsPage />)} />
            <Route path="/dashboard" element={gate("node", "Overview", <DashboardPage />)} />
            <Route path="/native-calls" element={gate("node", "Native tool calls (this machine)", <NativeCallsPage />)} />

            {/* Central's fleet views — every one of them an endpoint that had no UI at all. */}
            <Route path="/fleet/overview" element={gate("central", "Fleet overview", <FleetOverviewPage />)} />
            <Route path="/fleet/enforcement" element={gate("central", "Enforcement divergence", <FleetEnforcementPage />)} />
            {/* Nodes and Hook integrity merged into one view — the roster and its governance check
                are one health question. The old /fleet/hooks path redirects so kept bookmarks and
                the host probe's UI links still land on the combined page. */}
            <Route path="/fleet/hooks" element={<Navigate to="/fleet/nodes" replace />} />
            <Route path="/fleet/nodes" element={gate("central", "Nodes", <FleetNodesPage />)} />
            <Route path="/fleet/nodes/:nodeId" element={gate("central", "Node", <FleetNodeDetailPage />)} />
            <Route path="/fleet/nodes/:nodeId/journal" element={gate("central", "Fault journal", <FleetNodeJournalPage />)} />
            <Route path="/fleet/native" element={gate("central", "Native tool observations", <FleetNativePage />)} />
            <Route path="/fleet/usage" element={gate("central", "Fleet usage", <FleetUsagePage />)} />
            <Route path="/fleet/events" element={gate("central", "Fleet events", <FleetEventsPage />)} />
            <Route path="/fleet/alerts" element={gate("central", "Alerts", <FleetAlertsPage />)} />
            <Route path="/fleet/shadow" element={gate("central", "Shadow reconciliation", <FleetShadowPage />)} />
            <Route path="/fleet/integrations" element={gate("central", "Integrations", <FleetIntegrationsPage />)} />
            {/* One integration or provider in full — its owned capabilities crossed with the roles it
                targets, each pair a live grant you can toggle. Central-scoped like its parent list:
                the per-role grant matrix reads /api/fleet/integrations/:id/detail, authority-only. */}
            <Route path="/fleet/integrations/:id" element={gate("central", "Integration", <FleetIntegrationDetailPage />)} />

            {/* Central's POLICY CONTROL PLANE — the other half of what moved here, and the half
                that had no UI at all until now. The fleet routes above are observation; every one
                of these can change what thirty machines are allowed to do, which is why they are a
                group of their own rather than four more entries under Fleet.

                Their node-scoped namesakes above (/catalog, /principals, /grants, /approvals) are
                left exactly as they were. They are correct for a node and simply unreachable while
                central serves the only dashboard — see HostGate, which now points at these. */}
            <Route path="/policy/catalog" element={gate("central", "Capability catalog", <PolicyCatalogPage />)} />
            <Route path="/policy/principals" element={gate("central", "Principals", <PolicyPrincipalsPage />)} />
            <Route path="/policy/grants" element={gate("central", "Grants", <PolicyGrantsPage />)} />
            <Route path="/policy/approvals" element={gate("central", "Approvals", <PolicyApprovalsPage />)} />

            {/* Central's own settings — its deployment posture and the fleet-wide policy parameters
                it distributes. Central-scoped: it reads central's config and the node-profile
                ceilings, neither of which a node holds. The node "Config" menu (providers, sources,
                invoke) it visually replaces stayed node-scoped and became CLIs — item 4. */}
            <Route path="/settings" element={gate("central", "Settings", <FleetSettingsPage />)} />

            {/* The Sandbox is host-agnostic — every decision it shows is computed in the browser
                (pages/playground/sim.ts), so it needs no API and works on node and on the public
                central demo alike. Scoped "any" for exactly that reason. */}
            <Route path="/sandbox" element={gate("any", "Sandbox", <PlaygroundPage />)} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="*" element={<Home />} />
          </Route>
        </Routes>
        <OnboardingGate />
      </HashRouter>
    </OnboardingProvider>
    </EnforcementPauseProvider>
    </HostProvider>
  );
}

/**
 * Where "/" goes, decided by who is serving.
 *
 * A fixed redirect cannot be right for both: central's home is the fleet, and a node's — reached
 * through the Vite dev proxy, or by a bookmark someone kept — is the machine-local overview. Sent
 * to the wrong one, the first thing a visitor sees is the "this lives on another host" notice,
 * which is the correct page in the wrong place.
 */
function Home() {
  const { loading, allows } = useHost();
  if (loading) {
    return (
      <div className="page">
        <div className="loading">Checking which host is serving this dashboard…</div>
      </div>
    );
  }
  return <Navigate to={allows("central") ? "/fleet/overview" : "/dashboard"} replace />;
}

// Router-nested so the wizard's "Go to catalog"/"Go to dashboard" buttons can navigate — the
// wizard itself renders outside <Routes>, as an overlay on top of whatever page is current.
//
// NOT ON CENTRAL. Every step of the wizard drives a machine-local route — install a provider's
// hooks, run discovery, browse the server's directories — and central mounts none of them. On a
// fresh browser against central it would open by itself and fail at the first step, which is a
// worse first impression than the fleet view it would be covering. Hook installation is a CLI
// now (`npm run providers:install`), so nothing is lost by it staying shut.
function OnboardingGate() {
  const { visible } = useOnboarding();
  const { allows } = useHost();
  return visible && allows("node") ? <OnboardingWizard /> : null;
}
