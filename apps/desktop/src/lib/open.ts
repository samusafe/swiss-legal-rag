import { openUrl } from "@tauri-apps/plugin-opener";

/** Open a URL in the system browser — Tauri opener inside the app,
 * window.open fallback when running in a plain browser (pnpm dev). */
export function openExternal(url: string): void {
  if ("__TAURI_INTERNALS__" in window) {
    openUrl(url).catch((error: unknown) => console.error("failed to open URL", error));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
