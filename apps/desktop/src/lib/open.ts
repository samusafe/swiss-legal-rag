import { openPath, openUrl } from "@tauri-apps/plugin-opener";

// Citation `eli` values originate from the backend, but this is defense-in-depth:
// only ever open links to the official Fedlex site.
const FEDLEX_PREFIX = "https://www.fedlex.admin.ch/";

/** Open a URL in the system browser — Tauri opener inside the app,
 * window.open fallback when running in a plain browser (pnpm dev).
 * Refuses (no-op + warn) any URL that is not on the official Fedlex domain. */
export function openExternal(url: string): void {
  if (!url.startsWith(FEDLEX_PREFIX)) {
    console.warn("openExternal: refusing non-Fedlex URL", url);
    return;
  }

  if ("__TAURI_INTERNALS__" in window) {
    openUrl(url).catch((error: unknown) => console.error("failed to open URL", error));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Opens the repo's corpus.yaml with the system default app (a text/YAML
 * editor). Dev convenience for repo contributors: `tauri dev` runs from
 * apps/desktop/src-tauri, so this relative path resolves to the repo root
 * corpus.yaml. Not meaningful in a packaged build (corpus.yaml isn't bundled
 * with the app), where it silently fails and is logged. */
export function openCorpusYaml(): void {
  openPath("../../corpus.yaml").catch((error: unknown) =>
    console.error("failed to open corpus.yaml", error),
  );
}
