import { Navigate, Route, HashRouter, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { CatalogPage } from "./pages/CatalogPage";
import { PrincipalsPage } from "./pages/PrincipalsPage";
import { GrantsPage } from "./pages/GrantsPage";
import { SkillsPage } from "./pages/SkillsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { FleetPage } from "./pages/FleetPage";
import { DocsPage } from "./pages/DocsPage";
import { SourcesPage } from "./pages/SourcesPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { HookIntegrityPage } from "./pages/HookIntegrityPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { AgentOwnersPage } from "./pages/AgentOwnersPage";
import { DriftPage } from "./pages/DriftPage";
import { NativeCallsPage } from "./pages/NativeCallsPage";
import { InvokeDemoPage } from "./pages/InvokeDemoPage";
import { OnboardingProvider, useOnboarding } from "./hooks/useOnboarding";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { EnforcementPauseProvider } from "./hooks/useEnforcementPause";

export default function App() {
  return (
    // Outside the router: the enforcement-pause banner lives in the app chrome and has to survive
    // navigation, and the control on the Hook Integrity page shares this state so opening a window
    // puts the banner up at once rather than a poll interval later.
    <EnforcementPauseProvider>
    <OnboardingProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/hook-integrity" element={<HookIntegrityPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/agent-owners" element={<AgentOwnersPage />} />
            <Route path="/drift" element={<DriftPage />} />
            <Route path="/invoke" element={<InvokeDemoPage />} />
            <Route path="/principals" element={<PrincipalsPage />} />
            <Route path="/grants" element={<GrantsPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="/native-calls" element={<NativeCallsPage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="*" element={<Navigate to="/grants" replace />} />
          </Route>
        </Routes>
        <OnboardingGate />
      </HashRouter>
    </OnboardingProvider>
    </EnforcementPauseProvider>
  );
}

// Router-nested so the wizard's "Go to catalog"/"Go to dashboard" buttons can navigate — the
// wizard itself renders outside <Routes>, as an overlay on top of whatever page is current.
function OnboardingGate() {
  const { visible } = useOnboarding();
  return visible ? <OnboardingWizard /> : null;
}
