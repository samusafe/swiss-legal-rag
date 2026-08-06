import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHealth } from "./useHealth";

vi.mock("../lib/api", () => ({
  getHealth: vi.fn(),
}));

import { getHealth } from "../lib/api";

const getHealthMock = vi.mocked(getHealth);

describe("useHealth", () => {
  beforeEach(() => {
    getHealthMock.mockReset();
  });

  it("reports online once /health responds ok", async () => {
    getHealthMock.mockResolvedValue(true);
    const { result } = renderHook(() => useHealth());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("starts offline and stays offline while /health fails", async () => {
    getHealthMock.mockResolvedValue(false);
    const { result } = renderHook(() => useHealth());
    await waitFor(() => expect(getHealthMock).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });
});
