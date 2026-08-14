import { NavLink, Outlet } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { useOnboarding } from "../hooks/useOnboarding";

const LINKS = [
  { to: "/catalog", label: "Catalog" },
  { to: "/sources", label: "Sources" },
  { to: "/providers", label: "Providers" },
  { to: "/principals", label: "Principals" },
  { to: "/grants", label: "Grants" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/fleet", label: "Fleet" },
  { to: "/docs", label: "Docs" },
];

export function Layout() {
  const { open } = useOnboarding();
  return (
    <div className="app-shell">
      <nav className="topnav">
        <span className="brand">Capability Governance</span>
        {LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) => (isActive ? "active" : undefined)}
          >
            {link.label}
          </NavLink>
        ))}
        <span className="topnav-spacer" />
        <button className="setup-guide-link" onClick={open}>
          Setup guide
        </button>
        <ThemeToggle />
      </nav>
      <Outlet />
    </div>
  );
}
