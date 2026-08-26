import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { EnforcementPauseBanner } from "./EnforcementPauseBanner";
import { useOnboarding } from "../hooks/useOnboarding";
import { useSidebarCollapse } from "../hooks/useSidebarCollapse";
import { useHost } from "../hooks/useHost";
import type { PageScope } from "../hooks/useHost";

const REPO_URL = "https://github.com/ejbrahms/Windrow";

// EVERY NAV ENTRY CARRIES THE HOST IT WORKS ON, and the ones that do not work here are not drawn
// (docs/design/dashboard-placement.md item 4). There is one bundle, served by central, and central
// mounts no machine-local route — so on central the whole left-hand column is Policy, Fleet and
// Docs, which is an honest picture of what that host can answer. A stale bookmark still reaches
// the page, and the page still explains itself (see HostGate); what the nav refuses to do is
// *offer* a destination that cannot work.
//
// Undetected hosts show everything. See ../hooks/useHost.tsx: a probe that could not complete must
// not blank the navigation, because "the app is broken" is a worse and less true message than
// "that route is not on this host".

interface NavEntry {
  to: string;
  label: string;
  scope: PageScope;
  /** Match this path exactly rather than as a prefix, for a link whose path is a prefix of other
   *  links' paths — without it the parent would stay bold on every child route. */
  end?: boolean;
}

// Docs is a top-level destination like the rest of these five. Fleet, Dashboard, Config and
// Security (below) are expandable groups rather than flat links.
const LINKS: NavEntry[] = [
  { to: "/grants", label: "Grants", scope: "node" },
  { to: "/principals", label: "Principals", scope: "node" },
  { to: "/catalog", label: "Catalog", scope: "node" },
  { to: "/skills", label: "Skills", scope: "node" },
];

// Settings is central-scoped and Docs works anywhere. Settings is the central counterpart to the
// node's old "Config" group: central mounts no machine-local route, so its settings are its own
// deployment posture and the fleet-wide policy parameters it distributes, not one machine's disk.
const TRAILING_LINKS: NavEntry[] = [
  { to: "/settings", label: "Settings", scope: "central" },
  // Host-agnostic and self-contained (see App.tsx's /sandbox): a playful, in-browser toy of the
  // broker that runs on the public demo with no backend. Sits by Docs — both work anywhere.
  { to: "/sandbox", label: "Sandbox", scope: "any" },
  { to: "/docs", label: "Docs", scope: "any" },
];

const NAV_GROUPS: { key: string; label: string; links: NavEntry[] }[] = [
  {
    // POLICY BEFORE FLEET, and control before observation. These four are the only entries in the
    // whole navigation that CHANGE anything fleet-wide — central is the single writer for policy,
    // so a toggle behind one of them is written once and replicated to every node. Grants,
    // Principals and Catalog were the first three flat links in this nav before central served the
    // only dashboard (see LINKS above, all of them node-scoped and all of them filtered out here);
    // putting the group first keeps them where anyone who used this app already looks.
    key: "policy",
    label: "Policy",
    links: [
      { to: "/policy/grants", label: "Grants", scope: "central" },
      { to: "/policy/principals", label: "Principals", scope: "central" },
      { to: "/policy/catalog", label: "Catalog", scope: "central" },
      { to: "/policy/approvals", label: "Approvals", scope: "central" },
    ],
  },
  {
    // "Is governance actually wired on that box" is the question every other view here presupposes
    // an answer to, and until item 2 shipped it could only be asked one machine at a time — which
    // meant, in practice, that nobody asked. It now rides on the Nodes roster: one machine, one
    // row, its hook state a badge, with the full hook-integrity table a tab away on the same page.
    key: "fleet",
    label: "Fleet",
    links: [
      { to: "/fleet/overview", label: "Overview", scope: "central" },
      { to: "/fleet/nodes", label: "Nodes & Hooks", scope: "central" },
      // "Is that box still enforcing right now" — the pause, the grace lease and the year-fuse
      // credential, §5. It sits beside Nodes because they are the two health questions the rest of
      // these views presuppose an answer to.
      { to: "/fleet/enforcement", label: "Enforcement", scope: "central" },
      // What each integration is set to fleet-wide and which boxes run it — the cross-node view the
      // node's own Providers page cannot give, plus the one control here that writes fleet-wide
      // (enabling grants, which replicate). Sits with the config/health cluster, above the
      // observation views below.
      { to: "/fleet/integrations", label: "Integrations", scope: "central" },
      { to: "/fleet/native", label: "Native Observations", scope: "central" },
      { to: "/fleet/usage", label: "Usage", scope: "central" },
      { to: "/fleet/events", label: "Events", scope: "central" },
      { to: "/fleet/alerts", label: "Alerts", scope: "central" },
      { to: "/fleet/shadow", label: "Shadow", scope: "central" },
    ],
  },
  {
    key: "dashboard",
    label: "Dashboard",
    links: [
      { to: "/dashboard", label: "Overview", scope: "node" },
      { to: "/native-calls", label: "Native Tool Calls", scope: "node" },
    ],
  },
  {
    key: "config",
    label: "Config",
    links: [
      { to: "/providers", label: "Providers & Integrations", scope: "node" },
      { to: "/sources", label: "Sources", scope: "node" },
      { to: "/invoke", label: "Invoke Demo", scope: "node" },
    ],
  },
  {
    key: "security",
    label: "Security",
    links: [
      { to: "/hook-integrity", label: "Hook Integrity", scope: "node" },
      { to: "/approvals", label: "Approvals", scope: "node" },
      { to: "/agent-owners", label: "Agent Owners", scope: "node" },
      { to: "/drift", label: "Drift", scope: "node" },
    ],
  },
];

// One inline icon per nav item, built only from straight-line/arc primitives so they read
// cleanly at 16px in the collapsed rail.
const NAV_ICONS: Record<string, JSX.Element> = {
  "/grants": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.5 2.5L16 9.5" />
    </svg>
  ),
  "/principals": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="9" r="4" />
      <circle cx="16" cy="12" r="3.4" />
    </svg>
  ),
  "/catalog": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="14" y2="18" />
    </svg>
  ),
  "/skills": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5v4M12 16.5v4M4 12h4M16 12h4" />
      <path d="M6.5 6.5l2.8 2.8M14.7 14.7l2.8 2.8M17.5 6.5l-2.8 2.8M9.3 14.7l-2.8 2.8" />
    </svg>
  ),
  // Terminal glyph for the Sandbox — a prompt chevron and caret, the console it opens.
  "/sandbox": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="1.5" />
      <path d="M7 9.5l3 2.5-3 2.5" />
      <line x1="12.5" y1="15" x2="16.5" y2="15" />
    </svg>
  ),
  "/docs": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="3" width="14" height="18" rx="1" />
      <line x1="8" y1="8" x2="16" y2="8" />
      <line x1="8" y1="12" x2="16" y2="12" />
      <line x1="8" y1="16" x2="12" y2="16" />
    </svg>
  ),
  // The gear the node's "Config" group used, now central's Settings link — same visual language for
  // the same idea (this host's configuration), a host apart.
  "/settings": (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7L16 16M8 8 6.3 6.3" />
    </svg>
  ),
};

// Group icons, keyed by group key rather than route since a group has no single "to".
const GROUP_ICONS: Record<string, JSX.Element> = {
  policy: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5 5 6.3v5.4c0 4.4 2.9 7.6 7 8.8 4.1-1.2 7-4.4 7-8.8V6.3L12 3.5Z" />
      <circle cx="12" cy="11" r="2.2" />
      <path d="M12 13.2v3" />
    </svg>
  ),
  fleet: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="6" rx="1" />
      <rect x="3" y="14" width="18" height="6" rx="1" />
      <line x1="6.5" y1="7" x2="6.6" y2="7" />
      <line x1="6.5" y1="17" x2="6.6" y2="17" />
    </svg>
  ),
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" />
      <rect x="13" y="4" width="7" height="7" />
      <rect x="4" y="13" width="7" height="7" />
      <rect x="13" y="13" width="7" height="7" />
    </svg>
  ),
  config: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="2.6" />
      <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7L16 16M8 8 6.3 6.3" />
    </svg>
  ),
  security: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5 5 6.3v5.4c0 4.4 2.9 7.6 7 8.8 4.1-1.2 7-4.4 7-8.8V6.3L12 3.5Z" />
      <path d="M9.2 12.2l1.9 1.9 3.7-3.9" />
    </svg>
  ),
};

const CHEVRON = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="5 3 10 8 5 13" />
  </svg>
);

function NavGroup({
  group,
  collapsed,
}: {
  group: { key: string; label: string; links: NavEntry[] };
  collapsed: boolean;
}) {
  const location = useLocation();
  const isActive = group.links.some((link) => location.pathname.startsWith(link.to));
  const [open, setOpen] = useState(isActive);
  const [flyoutPos, setFlyoutPos] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Navigating to a page inside this group (including via browser back/forward, or a link
  // elsewhere) should always leave the group expanded with the current page visible and bolded —
  // never collapsed just because a click handler closed it on the way there.
  useEffect(() => {
    if (isActive) setOpen(true);
  }, [isActive]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Collapsed flyout is position: fixed (see app.css) so it escapes .sidebar-nav's clipping
  // box instead of overflowing it — that overflow is what produced the sidebar's scrollbar.
  // Fixed positioning needs explicit coords, so read the trigger's own rect on open.
  useEffect(() => {
    if (!open || !collapsed) {
      setFlyoutPos(null);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setFlyoutPos({ top: rect.top, left: rect.right + 6 });
  }, [open, collapsed]);

  return (
    <div className={"navgroup" + (open ? " open" : "")} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className={"navitem navgroup-trigger" + (isActive ? " active" : "")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="nav-icon">{GROUP_ICONS[group.key]}</span>
        <span className="nav-label">{group.label}</span>
        <span className="navgroup-chevron">{CHEVRON}</span>
        <span className="navtip">{group.label}</span>
      </button>
      {open && (
        <div
          className={collapsed ? "navgroup-flyout" : "navgroup-sublist"}
          style={collapsed && flyoutPos ? { top: flyoutPos.top, left: flyoutPos.left } : undefined}
        >
          {group.links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              // Collapsed rail shows this as a floating flyout, so close it on click like any
              // other menu. Expanded, it's an inline sublist — leave it open so the group stays
              // expanded with the newly-current page bolded, instead of collapsing on click.
              onClick={() => collapsed && setOpen(false)}
              className={({ isActive: linkActive }) => "navitem navitem-sub" + (linkActive ? " active" : "")}
            >
              <span className="nav-label">{link.label}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { open } = useOnboarding();
  const { collapsed, toggle } = useSidebarCollapse();
  const { allows } = useHost();

  const links = LINKS.filter((l) => allows(l.scope));
  const trailing = TRAILING_LINKS.filter((l) => allows(l.scope));
  // A group whose every link belongs to the other host is not rendered empty — it is not rendered.
  const groups = NAV_GROUPS.map((g) => ({ ...g, links: g.links.filter((l) => allows(l.scope)) })).filter(
    (g) => g.links.length > 0,
  );

  return (
    <div className="app-shell">
      <aside className={"sidebar" + (collapsed ? " collapsed" : "")}>
        <div className="sidebar-top">
          <span className="brand">
            <svg className="brand-icon mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <polygon points="2,2.6 2,5.6 20,7.1 20,6.5" fill="var(--accent)" />
              <polygon points="2,9.6 2,12.2 15.5,13.3 15.5,12.7" fill="var(--accent)" />
              <polygon points="2,15.8 2,18 11,18.7 11,18.2" fill="var(--cyan)" />
            </svg>
            <span className="nav-label wordmark">Windrow</span>
          </span>
        </div>

        <nav className="sidebar-nav">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => "navitem" + (isActive ? " active" : "")}
            >
              <span className="nav-icon">{NAV_ICONS[link.to]}</span>
              <span className="nav-label">{link.label}</span>
              <span className="navtip">{link.label}</span>
            </NavLink>
          ))}
          {groups.map((group) => (
            <NavGroup key={group.key} group={group} collapsed={collapsed} />
          ))}
          {trailing.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => "navitem" + (isActive ? " active" : "")}
            >
              <span className="nav-icon">{NAV_ICONS[link.to]}</span>
              <span className="nav-label">{link.label}</span>
              <span className="navtip">{link.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="util-row">
            <a
              className="github-link icon-btn"
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="View on GitHub"
              title="View on GitHub"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
            </a>
            <button className="setup-guide-link icon-btn" onClick={open} aria-label="Setup guide" title="Setup guide">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M6.1 6.2a1.9 1.9 0 1 1 2.7 1.7c-.6.3-1 .8-1 1.4v.3" />
                <circle cx="8" cy="11.6" r="0.1" fill="currentColor" />
              </svg>
            </button>
            <ThemeToggle />
          </div>
          <button
            type="button"
            className="collapse-toggle"
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="10 3 5 8 10 13" />
            </svg>
          </button>
        </div>
      </aside>
      <div className="shell-main">
        {/* Above the page, not inside it: a pause is invisible while it is on, so the one thing
            that makes it hard to forget has to follow you across every route. Renders nothing at
            all in the normal case. */}
        <EnforcementPauseBanner />
        <Outlet />
      </div>
    </div>
  );
}
