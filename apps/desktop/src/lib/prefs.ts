/** Typed JSON localStorage helpers, namespaced under `slr.`. */
export const prefs = {
  get<T>(key: string, fallback: T): T {
    const raw = localStorage.getItem(`slr.${key}`);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  set<T>(key: string, value: T): void {
    localStorage.setItem(`slr.${key}`, JSON.stringify(value));
  },
};
