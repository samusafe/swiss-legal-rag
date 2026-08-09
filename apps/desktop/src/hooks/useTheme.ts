import { useCallback, useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";
const KEY = "slr.theme";

function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(resolved: "light" | "dark"): void {
  document.documentElement.className = `chancery-${resolved} ${resolved}`;
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemePref>(
    () => (localStorage.getItem(KEY) as ThemePref) ?? "system",
  );
  const [systemIsDark, setSystemIsDark] = useState<boolean>(systemDark);
  const resolved: "light" | "dark" =
    theme === "system" ? (systemIsDark ? "dark" : "light") : theme;

  useEffect(() => {
    apply(resolved);
  }, [resolved]);

  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemIsDark(systemDark());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((t: ThemePref) => {
    localStorage.setItem(KEY, t);
    setThemeState(t);
  }, []);

  return { theme, resolved, setTheme };
}
