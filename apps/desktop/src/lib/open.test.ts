import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
}));

import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { openCorpusYaml, openExternal } from "./open";

const VALID_URL = "https://www.fedlex.admin.ch/eli/cc/24/233_245_233/en";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("openExternal", () => {
  it("uses the Tauri opener when running inside the Tauri webview", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);

    openExternal(VALID_URL);

    expect(openUrl).toHaveBeenCalledWith(VALID_URL);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("falls back to window.open in a plain browser", () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);

    openExternal(VALID_URL);

    expect(windowOpen).toHaveBeenCalledWith(VALID_URL, "_blank", "noopener,noreferrer");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("refuses non-Fedlex URLs in the Tauri webview and warns", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    openExternal("https://evil.example/phish");

    expect(openUrl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "openExternal: refusing non-Fedlex URL",
      "https://evil.example/phish",
    );
  });

  it("refuses non-Fedlex URLs in a plain browser and warns", () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    openExternal("https://evil.example/phish");

    expect(windowOpen).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "openExternal: refusing non-Fedlex URL",
      "https://evil.example/phish",
    );
  });

  it("refuses a URL that merely contains the Fedlex host, not starting with it", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    openExternal("https://evil.example/https://www.fedlex.admin.ch/");

    expect(openUrl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe("openCorpusYaml", () => {
  it("opens the repo-root corpus.yaml via the opener plugin", () => {
    openCorpusYaml();

    expect(openPath).toHaveBeenCalledWith("../../corpus.yaml");
  });

  it("logs, rather than throws, when the opener plugin rejects", async () => {
    vi.mocked(openPath).mockRejectedValueOnce(new Error("no default app"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    openCorpusYaml();
    await Promise.resolve(); // flush the rejection's .catch()

    expect(error).toHaveBeenCalledWith("failed to open corpus.yaml", expect.any(Error));
  });
});
