import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CitationChip } from "./CitationChip";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

import { openUrl } from "@tauri-apps/plugin-opener";

const RESOLVED = {
  raw: "[SR 220 Art. 335c]",
  sr: "220",
  article: "335c",
  eli: "https://example.test/e",
  resolved: true,
};
const UNRESOLVED = {
  raw: "[SR 210 Art. 1]",
  sr: "210",
  article: "1",
  eli: null,
  resolved: false,
};

describe("CitationChip", () => {
  it("opens the Fedlex page on click when resolved", async () => {
    const user = userEvent.setup();
    render(
      <HeroUIProvider>
        <CitationChip citation={RESOLVED} />
      </HeroUIProvider>,
    );

    await user.click(screen.getByRole("button", { name: "[SR 220 Art. 335c]" }));

    expect(openUrl).toHaveBeenCalledWith("https://example.test/e");
  });

  it("renders unresolved citations as plain, non-clickable chips", () => {
    render(
      <HeroUIProvider>
        <CitationChip citation={UNRESOLVED} />
      </HeroUIProvider>,
    );

    expect(screen.getByText("[SR 210 Art. 1]")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
