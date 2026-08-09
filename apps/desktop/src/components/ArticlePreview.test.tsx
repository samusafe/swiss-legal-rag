import { HeroUIProvider } from "@heroui/react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../lib/api";
import { ArticlePreview } from "./ArticlePreview";

vi.mock("../lib/api", () => ({
  search: vi.fn(),
}));
vi.mock("../lib/open", () => ({
  openExternal: vi.fn(),
}));

import { search } from "../lib/api";
import { openExternal } from "../lib/open";

const searchMock = vi.mocked(search);

const MATCH: SearchResult = {
  sr: "220",
  article: "335c",
  heading: "Kündigungsfrist",
  context: "Die Kündigungsfrist beträgt einen Monat während des ersten Dienstjahres.",
  text: "full text",
  eli: "https://example.test/220",
  actName: "Obligationenrecht",
  score: 9.5,
};

const OTHER: SearchResult = {
  sr: "210",
  article: "1",
  heading: null,
  context: null,
  text: "unrelated text",
  eli: "https://example.test/210",
  actName: "ZGB",
  score: 4.75,
};

const MATCH2: SearchResult = {
  sr: "700",
  article: "9",
  heading: null,
  context: "some other article's snippet",
  text: "full text 2",
  eli: "https://example.test/700",
  actName: "Some Act",
  score: 3.1,
};

beforeEach(() => {
  searchMock.mockReset();
  vi.mocked(openExternal).mockReset();
});

async function openPreview(srNumber = "220", article = "335c") {
  const user = userEvent.setup();
  render(
    <HeroUIProvider>
      <ArticlePreview
        srNumber={srNumber}
        article={article}
        trigger={<button type="button">open preview</button>}
      />
    </HeroUIProvider>,
  );
  await user.click(screen.getByRole("button", { name: "open preview" }));
  const dialog = await screen.findByRole("dialog");
  return { user, dialog };
}

describe("ArticlePreview", () => {
  it("shows a loading skeleton, then the matching article text, on open", async () => {
    let resolveSearch: (results: SearchResult[]) => void = () => {};
    searchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );

    const { dialog } = await openPreview();

    expect(within(dialog).getByRole("status")).toBeInTheDocument();

    resolveSearch([MATCH]);

    expect(
      await within(dialog).findByText(
        "Die Kündigungsfrist beträgt einen Monat während des ersten Dienstjahres.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("status")).not.toBeInTheDocument();
    expect(searchMock).toHaveBeenCalledWith("SR 220 Art. 335c", 3, "de");
  });

  it("falls back to the empty-results message when no result matches sr+article", async () => {
    searchMock.mockResolvedValue([OTHER]);

    const { dialog } = await openPreview("500", "9");

    expect(await within(dialog).findByText("No results found.")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "View on Fedlex" })).not.toBeInTheDocument();
  });

  it("shows the localized error message when search fails", async () => {
    searchMock.mockRejectedValue(new Error("boom"));

    const { dialog } = await openPreview("600", "9");

    expect(await within(dialog).findByText("Search failed. Please try again.")).toBeInTheDocument();
  });

  it("the Fedlex button opens the matched result's link", async () => {
    searchMock.mockResolvedValue([MATCH2]);
    const { user, dialog } = await openPreview("700", "9");

    const button = await within(dialog).findByRole("button", { name: "View on Fedlex" });
    await user.click(button);

    expect(openExternal).toHaveBeenCalledWith("https://example.test/700");
  });

  it("caches the result per key, skipping a second fetch when reopened", async () => {
    searchMock.mockResolvedValue([MATCH]);
    const user = userEvent.setup();
    render(
      <HeroUIProvider>
        <ArticlePreview
          srNumber="220"
          article="335c-cache"
          trigger={<button type="button">open preview</button>}
        />
      </HeroUIProvider>,
    );

    const trigger = screen.getByRole("button", { name: "open preview" });
    await user.click(trigger);
    await screen.findByRole("dialog");
    await user.click(trigger);
    await user.click(trigger);
    await screen.findByRole("dialog");

    expect(searchMock).toHaveBeenCalledTimes(1);
  });
});
