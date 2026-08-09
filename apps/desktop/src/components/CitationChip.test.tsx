import { HeroUIProvider } from "@heroui/react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CitationChip } from "./CitationChip";
import type { SearchResult } from "../lib/api";

vi.mock("../lib/api", () => ({
  search: vi.fn(),
}));
vi.mock("../lib/open", () => ({
  openExternal: vi.fn(),
}));

import { search } from "../lib/api";
import { openExternal } from "../lib/open";

const searchMock = vi.mocked(search);

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

const MATCH: SearchResult = {
  sr: "220",
  article: "335c",
  heading: null,
  context: "matched snippet",
  text: "full text",
  eli: "https://example.test/e",
  actName: "Obligationenrecht",
  score: 9.5,
};

beforeEach(() => {
  searchMock.mockReset();
  vi.mocked(openExternal).mockReset();
});

describe("CitationChip", () => {
  it("opens an ArticlePreview popover when a resolved citation is clicked", async () => {
    searchMock.mockResolvedValue([MATCH]);
    const user = userEvent.setup();
    render(
      <HeroUIProvider>
        <CitationChip citation={RESOLVED} />
      </HeroUIProvider>,
    );

    await user.click(screen.getByRole("button", { name: "[SR 220 Art. 335c]" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("matched snippet")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "View on Fedlex" }));

    expect(openExternal).toHaveBeenCalledWith("https://example.test/e");
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
