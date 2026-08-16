import { Navigate, Route, HashRouter, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { CatalogPage } from "./pages/CatalogPage";
import { PrincipalsPage } from "./pages/PrincipalsPage";
import { GrantsPage } from "./pages/GrantsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { FleetPage } from "./pages/FleetPage";
import { DocsPage } from "./pages/DocsPage";
import { SourcesPage } from "./pages/SourcesPage";
import { ProvidersPage } from "./pages/ProvidersPage";
import { HookIntegrityPage } from "./pages/HookIntegrityPage";
import { OnboardingProvider, useOnboarding } from "./hooks/useOnboarding";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";

export default function App() {
  return (
    <OnboardingProvider>
      <HashRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/hook-integrity" element={<HookIntegrityPage />} />
            <Route path="/principals" element={<PrincipalsPage />} />
            <Route path="/grants" element={<GrantsPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="*" element={<Navigate to="/grants" replace />} />
          </Route>
        </Routes>
        <OnboardingGate />
      </HashRouter>
    </OnboardingProvider>
  );
}

// Router-nested so the wizard's "Go to catalog"/"Go to dashboard" buttons can navigate — the
// wizard itself renders outside <Routes>, as an overlay on top of whatever page is current.
function OnboardingGate() {
  const { visible } = useOnboarding();
  return visible ? <OnboardingWizard /> : null;
}
