import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

import { openUrl } from "@tauri-apps/plugin-opener";
import { openExternal } from "./open";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("openExternal", () => {
  it("uses the Tauri opener when running inside the Tauri webview", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);

    openExternal("https://x.test/");

    expect(openUrl).toHaveBeenCalledWith("https://x.test/");
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("falls back to window.open in a plain browser", () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);

    openExternal("https://x.test/");

    expect(windowOpen).toHaveBeenCalledWith("https://x.test/", "_blank", "noopener,noreferrer");
    expect(openUrl).not.toHaveBeenCalled();
  });
});
