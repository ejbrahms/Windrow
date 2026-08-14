import { useTheme } from "../hooks/useTheme";

/** Sun/moon icon toggle — defaults to the OS theme, but lets the user pin light or dark. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {isDark ? (
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M10 2.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 2.5Zm0 12.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5a.75.75 0 0 1 .75-.75ZM17.5 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5a.75.75 0 0 1 .75.75ZM4.75 10a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1 0-1.5H4a.75.75 0 0 1 .75.75Zm10.16-5.66a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0ZM6.16 13.84a.75.75 0 0 1 0 1.06l-1.06 1.06a.75.75 0 1 1-1.06-1.06l1.06-1.06a.75.75 0 0 1 1.06 0Zm9.03 1.06a.75.75 0 0 1-1.06 0l-1.06-1.06a.75.75 0 1 1 1.06-1.06l1.06 1.06a.75.75 0 0 1 0 1.06ZM6.16 6.16a.75.75 0 0 1-1.06 0L4.04 5.1a.75.75 0 0 1 1.06-1.06l1.06 1.06a.75.75 0 0 1 0 1.06ZM10 6a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M17.29 12.05a7.25 7.25 0 0 1-9.34-9.34.75.75 0 0 0-.96-.96 8.75 8.75 0 1 0 11.26 11.26.75.75 0 0 0-.96-.96Z"
          />
        </svg>
      )}
    </button>
  );
}
