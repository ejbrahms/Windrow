import { NavLink, Outlet } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { SettingsMenu } from "./SettingsMenu";
import { useOnboarding } from "../hooks/useOnboarding";

const REPO_URL = "https://github.com/ejbrahms/Windrow";

// Providers, Sources, and Docs live under the Settings menu (see SettingsMenu) rather than
// as top-level links — they're configuration, not day-to-day governance views.
const LINKS = [
  { to: "/grants", label: "Grants" },
  { to: "/principals", label: "Principals" },
  { to: "/catalog", label: "Catalog" },
  { to: "/dashboard", label: "Dashboard" },
  { to: "/fleet", label: "Fleet" },
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
        <SettingsMenu />
        <span className="topnav-spacer" />
        <button className="setup-guide-link" onClick={open}>
          Setup guide
        </button>
        <a
          className="github-link"
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          aria-label="View on GitHub"
          title="View on GitHub"
        >
          <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
        </a>
        <ThemeToggle />
      </nav>
      <Outlet />
    </div>
  );
}
