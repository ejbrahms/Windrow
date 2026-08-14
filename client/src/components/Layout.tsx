import { NavLink, Outlet } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { to: "/catalog", label: "Catalog" },
  { to: "/principals", label: "Principals" },
  { to: "/grants", label: "Grants" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/fleet", label: "Fleet" },
  { to: "/docs", label: "Docs" },
];

export function Layout() {
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
        <ThemeToggle />
      </nav>
      <Outlet />
    </div>
  );
}
