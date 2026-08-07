import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

import { openUrl } from "@tauri-apps/plugin-opener";
import { openExternal } from "./open";

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
