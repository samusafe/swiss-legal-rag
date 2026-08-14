import { openUrl } from "@tauri-apps/plugin-opener";

// Citation `sourceUrl` values originate from the backend, but this is
// defense-in-depth: only ever open links to known official legal-text portals.
const ALLOWED_PREFIXES = [
  "https://www.fedlex.admin.ch/",
  "https://www.gesetzessammlung.sg.ch/",
  "https://www.belex.sites.be.ch/",
  // extend with each Phase-2 canton portal
];

/** Open a URL in the system browser — Tauri opener inside the app,
 * window.open fallback when running in a plain browser (pnpm dev).
 * Refuses (no-op + warn) any URL not on an allowlisted legal-text portal. */
export function openExternal(url: string): void {
  if (!ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    console.warn("openExternal: refusing non-allowlisted URL", url);
    return;
  }

  if ("__TAURI_INTERNALS__" in window) {
    openUrl(url).catch((error: unknown) => console.error("failed to open URL", error));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
