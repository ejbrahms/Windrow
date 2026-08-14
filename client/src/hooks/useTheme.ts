import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark";

const STORAGE_KEY = "cg-theme";

function getStored(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

function applyTheme(choice: ThemeChoice | null) {
  const root = document.documentElement;
  if (choice) {
    root.setAttribute("data-theme", choice);
  } else {
    root.removeAttribute("data-theme");
  }
}

/**
 * Tracks the resolved theme (what's actually painted) plus whether the user has
 * explicitly overridden the system preference. Defaults to following the OS
 * setting; the toggle sets an explicit choice that persists across visits.
 */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice | null>(() => getStored());
  const [resolved, setResolved] = useState<ThemeChoice>(
    () => getStored() ?? (systemPrefersDark() ? "dark" : "light"),
  );

  useEffect(() => {
    applyTheme(choice);
    setResolved(choice ?? (systemPrefersDark() ? "dark" : "light"));
  }, [choice]);

  useEffect(() => {
    if (choice) return; // explicit choice wins; stop following the system
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(mql.matches ? "dark" : "light");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [choice]);

  const setTheme = useCallback((next: ThemeChoice) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore write failures (private browsing, etc.)
    }
    setChoice(next);
  }, []);

  const toggle = useCallback(() => {
    setTheme(resolved === "dark" ? "light" : "dark");
  }, [resolved, setTheme]);

  return { theme: resolved, isExplicit: choice !== null, setTheme, toggle };
}
