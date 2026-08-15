import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";

const SETTINGS_LINKS = [
  { to: "/providers", label: "Providers & Integrations" },
  { to: "/sources", label: "Sources" },
  { to: "/docs", label: "Docs" },
];

/** Gear-icon dropdown grouping the configuration pages that don't need top-level billing. */
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="settings-menu" ref={rootRef}>
      <button
        type="button"
        className="settings-menu-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8.32 2.75h3.36l.46 2.02c.5.18.97.44 1.4.75l1.96-.66 1.68 2.91-1.53 1.4c.05.26.08.53.08.83s-.03.57-.08.83l1.53 1.4-1.68 2.91-1.96-.66c-.43.31-.9.57-1.4.75l-.46 2.02H8.32l-.46-2.02a5.86 5.86 0 0 1-1.4-.75l-1.96.66-1.68-2.91 1.53-1.4A5.9 5.9 0 0 1 4.27 10c0-.3.03-.57.08-.83l-1.53-1.4 1.68-2.91 1.96.66c.43-.31.9-.57 1.4-.75l.46-2.02Z"
          />
          <circle cx="10" cy="10" r="2.25" />
        </svg>
        Settings
      </button>
      {open && (
        <div className="settings-menu-dropdown" role="menu">
          {SETTINGS_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              {link.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
