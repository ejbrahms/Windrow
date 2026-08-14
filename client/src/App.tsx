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

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/grants" replace />} />
          <Route path="/catalog" element={<CatalogPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/principals" element={<PrincipalsPage />} />
          <Route path="/grants" element={<GrantsPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/fleet" element={<FleetPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="*" element={<Navigate to="/grants" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
