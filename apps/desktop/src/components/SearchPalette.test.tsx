import { HeroUIProvider } from "@heroui/react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../lib/api";
import { SearchPalette } from "./SearchPalette";

vi.mock("../lib/api", () => ({
  search: vi.fn(),
}));
vi.mock("../lib/audit", () => ({
  logAudit: vi.fn(),
}));

import { search } from "../lib/api";
import { logAudit } from "../lib/audit";

const searchMock = vi.mocked(search);
const logAuditMock = vi.mocked(logAudit);

const RESULT_A: SearchResult = {
  jurisdiction: "ch",
  collection: "SR",
  number: "220",
  article: "335c",
  heading: "Kündigungsfrist",
  context: "Die Kündigungsfrist beträgt einen Monat während des ersten Dienstjahres.",
  text: "full text a",
  sourceUrl: "https://example.test/a",
  actName: "Obligationenrecht",
  score: 9.5,
  citationLabel: "SR 220 Art. 335c",
};
const RESULT_B: SearchResult = {
  jurisdiction: "ch",
  collection: "SR",
  number: "210",
  article: "1",
  heading: null,
  context: null,
  text: "full text b",
  sourceUrl: "https://example.test/b",
  actName: "ZGB",
  score: 4.75,
  citationLabel: "SR 210 Art. 1",
};

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
  logAuditMock.mockReset();
});

function renderPalette(overrides: Partial<Parameters<typeof SearchPalette>[0]> = {}) {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  render(
    <HeroUIProvider>
      <SearchPalette {...props} />
    </HeroUIProvider>,
  );
  return props;
}

describe("SearchPalette", () => {
  it("is not rendered when closed", () => {
    renderPalette({ isOpen: false });

    expect(screen.queryByPlaceholderText("Search articles…")).not.toBeInTheDocument();
  });

  it("shows the idle hint before typing", () => {
    renderPalette();

    expect(
      screen.getByText("Type to search articles by SR number, article, or keyword."),
    ).toBeInTheDocument();
  });

  it("debounces: does not call api.search until 300ms after the last keystroke, mapping UI lang to a search lang", async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByPlaceholderText("Search articles…"), "termination");

    expect(searchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(searchMock).toHaveBeenCalled(), { timeout: 1000 });
    expect(searchMock).toHaveBeenCalledWith("termination", 8, "de", expect.any(AbortSignal));
  });

  it("logs search.query with the query, lang and result count once results land", async () => {
    searchMock.mockResolvedValue([RESULT_A]);
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByPlaceholderText("Search articles…"), "frist");

    await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 });
    expect(logAuditMock).toHaveBeenCalledWith(
      "search.query",
      expect.objectContaining({ query: expect.any(String), results: expect.any(Number) }),
      expect.any(Number),
    );
  });

  it("shows a persistent searching state (spinner + label) while the request is in flight", async () => {
    let resolveSearch: (results: SearchResult[]) => void = () => {};
    searchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByPlaceholderText("Search articles…"), "frist");

    expect(
      await screen.findByText(
        "Searching articles… this can take up to a minute on this device.",
        undefined,
        { timeout: 1000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();

    resolveSearch([RESULT_A]);
    expect(await screen.findByText("SR 220 · Art. 335c")).toBeInTheDocument();
  });

  it("renders SR/article/heading/snippet and a relative score bar for each result", async () => {
    searchMock.mockResolvedValue([RESULT_A, RESULT_B]);
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByPlaceholderText("Search articles…"), "frist");

    expect(await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 })).toBeInTheDocument();
    expect(screen.getByText("Kündigungsfrist")).toBeInTheDocument();
    expect(
      screen.getByText("Die Kündigungsfrist beträgt einen Monat während des ersten Dienstjahres."),
    ).toBeInTheDocument();
    expect(screen.getByText("SR 210 · Art. 1")).toBeInTheDocument();

    const barA = screen.getByText("SR 220 · Art. 335c").closest("button")?.querySelector(".bg-primary");
    const barB = screen.getByText("SR 210 · Art. 1").closest("button")?.querySelector(".bg-primary");
    expect(barA).toHaveStyle({ width: "100%" });
    expect(barB).toHaveStyle({ width: "50%" });
  });

  it("shows the localized empty state when there are no results", async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByPlaceholderText("Search articles…"), "nichts");

    expect(await screen.findByText("No results found.", undefined, { timeout: 1000 })).toBeInTheDocument();
  });

  it("shows the localized error state when the search fails", async () => {
    searchMock.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderPalette();

    await user.type(screen.getByPlaceholderText("Search articles…"), "fehler");

    expect(
      await screen.findByText("Search failed. Please try again.", undefined, { timeout: 1000 }),
    ).toBeInTheDocument();
  });

  it("clicking a result closes the palette and calls onSelect with that result", async () => {
    searchMock.mockResolvedValue([RESULT_A]);
    const user = userEvent.setup();
    const props = renderPalette();

    await user.type(screen.getByPlaceholderText("Search articles…"), "frist");
    await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 });
    await user.click(screen.getByText("SR 220 · Art. 335c"));

    expect(props.onSelect).toHaveBeenCalledWith([RESULT_A], 0);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("selecting the second row calls onSelect with the full results array and its index", async () => {
    searchMock.mockResolvedValue([RESULT_A, RESULT_B]);
    const user = userEvent.setup();
    const props = renderPalette();

    await user.type(screen.getByPlaceholderText("Search articles…"), "frist");
    await screen.findByText("SR 210 · Art. 1", undefined, { timeout: 1000 });
    await user.click(screen.getByText("SR 210 · Art. 1"));

    expect(props.onSelect).toHaveBeenCalledWith([RESULT_A, RESULT_B], 1);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("Enter selects the highlighted (first) result", async () => {
    searchMock.mockResolvedValue([RESULT_A, RESULT_B]);
    const user = userEvent.setup();
    const props = renderPalette();

    const input = screen.getByPlaceholderText("Search articles…");
    await user.type(input, "frist");
    await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 });
    await user.type(input, "{Enter}");

    expect(props.onSelect).toHaveBeenCalledWith([RESULT_A, RESULT_B], 0);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("ArrowDown/ArrowUp move the highlighted result before Enter selects it", async () => {
    searchMock.mockResolvedValue([RESULT_A, RESULT_B]);
    const user = userEvent.setup();
    const props = renderPalette();

    const input = screen.getByPlaceholderText("Search articles…");
    await user.type(input, "frist");
    await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 });

    await user.type(input, "{ArrowDown}");
    await user.type(input, "{Enter}");

    expect(props.onSelect).toHaveBeenCalledWith([RESULT_A, RESULT_B], 1);
  });

  it("Enter is a no-op while no results have loaded", async () => {
    const user = userEvent.setup();
    const props = renderPalette();

    const input = screen.getByPlaceholderText("Search articles…");
    await user.type(input, "frist{Enter}");

    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("Escape closes the palette", async () => {
    const user = userEvent.setup();
    const props = renderPalette();

    await user.type(screen.getByPlaceholderText("Search articles…"), "{Escape}");

    expect(props.onClose).toHaveBeenCalled();
  });

  it("clearing the query drops the results and shows the idle hint again", async () => {
    searchMock.mockResolvedValue([RESULT_A]);
    const user = userEvent.setup();
    renderPalette();

    const input = screen.getByPlaceholderText("Search articles…");
    await user.type(input, "frist");
    await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 });

    await user.clear(input);

    expect(
      screen.getByText("Type to search articles by SR number, article, or keyword."),
    ).toBeInTheDocument();
    expect(screen.queryByText("SR 220 · Art. 335c")).not.toBeInTheDocument();
  });

  it("resets its query when reopened after being closed", async () => {
    searchMock.mockResolvedValue([RESULT_A]);
    const user = userEvent.setup();
    const { rerender } = render(
      <HeroUIProvider>
        <SearchPalette isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} />
      </HeroUIProvider>,
    );

    await user.type(screen.getByPlaceholderText("Search articles…"), "frist");
    await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 });

    rerender(
      <HeroUIProvider>
        <SearchPalette isOpen={false} onClose={vi.fn()} onSelect={vi.fn()} />
      </HeroUIProvider>,
    );
    rerender(
      <HeroUIProvider>
        <SearchPalette isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} />
      </HeroUIProvider>,
    );

    expect(screen.getByPlaceholderText("Search articles…")).toHaveValue("");
    expect(screen.queryByText("SR 220 · Art. 335c")).not.toBeInTheDocument();
  });
});
