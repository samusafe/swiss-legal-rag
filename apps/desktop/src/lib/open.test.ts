import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

import { openUrl } from "@tauri-apps/plugin-opener";
import { openExternal } from "./open";

const FEDLEX_URL = "https://www.fedlex.admin.ch/eli/cc/24/233_245_233/en";
const SG_URL = "https://www.gesetzessammlung.sg.ch/app/de/texts_of_law/811.1";
const BE_URL = "https://www.belex.sites.be.ch/app/de/texts_of_law/101.1";
const EVIL_URL = "https://evil.example.com/";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("openExternal", () => {
  it("uses the Tauri opener when running inside the Tauri webview", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);

    openExternal(FEDLEX_URL);

    expect(openUrl).toHaveBeenCalledWith(FEDLEX_URL);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("falls back to window.open in a plain browser", () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);

    openExternal(FEDLEX_URL);

    expect(windowOpen).toHaveBeenCalledWith(FEDLEX_URL, "_blank", "noopener,noreferrer");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("allows the St. Gallen LexWork portal", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    openExternal(SG_URL);

    expect(openUrl).toHaveBeenCalledWith(SG_URL);
  });

  it("allows the Bern LexWork portal", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    openExternal(BE_URL);

    expect(openUrl).toHaveBeenCalledWith(BE_URL);
  });

  it("still blocks everything else, even after allowing a cantonal portal", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    openExternal(SG_URL);
    openExternal(EVIL_URL);

    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("refuses non-allowlisted URLs in the Tauri webview and warns", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    openExternal(EVIL_URL);

    expect(openUrl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("openExternal: refusing non-allowlisted URL", EVIL_URL);
  });

  it("refuses non-allowlisted URLs in a plain browser and warns", () => {
    const windowOpen = vi.spyOn(window, "open").mockImplementation(() => null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    openExternal(EVIL_URL);

    expect(windowOpen).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("openExternal: refusing non-allowlisted URL", EVIL_URL);
  });

  it("refuses a URL that merely contains an allowed host, not starting with it", () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    openExternal("https://evil.example/https://www.fedlex.admin.ch/");

    expect(openUrl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
