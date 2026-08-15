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
        <span className="brand">
          <svg
            className="brand-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M3 8h11a3 3 0 1 0-3-3" />
            <path d="M3 12h15a3 3 0 1 1-3 3" />
            <path d="M3 16h9a3 3 0 1 1-3 3" />
          </svg>
          Windrow
        </span>
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
