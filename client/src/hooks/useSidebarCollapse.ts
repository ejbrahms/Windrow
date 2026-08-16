import { useCallback, useState } from "react";

const STORAGE_KEY = "windrow.sidebarCollapsed";

function getStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Tracks whether the left sidebar is collapsed to icon-only. Persists across visits the
 * same way useTheme persists the light/dark choice. Defaults to expanded.
 */
export function useSidebarCollapse() {
  const [collapsed, setCollapsed] = useState<boolean>(() => getStored());

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore write failures (private browsing, etc.)
      }
      return next;
    });
  }, []);

  return { collapsed, toggle };
}
