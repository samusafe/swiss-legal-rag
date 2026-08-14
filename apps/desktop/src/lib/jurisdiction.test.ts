import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./audit", () => ({
  logAudit: vi.fn(),
}));

import { logAudit } from "./audit";
import { getJurisdiction, setJurisdiction, CANTONS, COVERED_CANTONS } from "./jurisdiction";

const logAuditMock = vi.mocked(logAudit);

describe("jurisdiction prefs", () => {
  beforeEach(() => {
    localStorage.clear();
    logAuditMock.mockReset();
  });

  it("defaults to no canton", () => {
    expect(getJurisdiction()).toEqual({ canton: null, commune: null });
  });

  it("round-trips through prefs under slr.jurisdiction", () => {
    setJurisdiction({ canton: "SG", commune: null });
    expect(getJurisdiction().canton).toBe("SG");
    expect(localStorage.getItem("slr.jurisdiction")).toBe(
      JSON.stringify({ canton: "SG", commune: null }),
    );
  });

  it("lists all 26 cantons and the covered subset", () => {
    expect(CANTONS).toHaveLength(26);
    expect(COVERED_CANTONS).toEqual(["BE", "SG"]);
  });

  it("logs settings.jurisdiction with the previous and next value", () => {
    setJurisdiction({ canton: "BE", commune: null });
    setJurisdiction({ canton: "SG", commune: null });

    expect(logAuditMock).toHaveBeenLastCalledWith("settings.jurisdiction", {
      from: { canton: "BE", commune: null },
      to: { canton: "SG", commune: null },
    });
  });
});
