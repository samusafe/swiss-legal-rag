import { HeroUIProvider } from "@heroui/react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../lib/db";
import type { SearchResult } from "../lib/api";
import { Sidebar } from "./Sidebar";

vi.mock("../lib/api", () => ({
  search: vi.fn(),
}));

import { search } from "../lib/api";

const searchMock = vi.mocked(search);

const CONVERSATIONS: Conversation[] = [
  { id: "c1", title: "First chat", createdAt: "t1", updatedAt: "t1" },
  { id: "c2", title: "", createdAt: "t2", updatedAt: "t2" },
];

const RESULT_A: SearchResult = {
  sr: "220",
  article: "335c",
  heading: "Kündigungsfrist",
  context: "Die Kündigungsfrist beträgt einen Monat während des ersten Dienstjahres.",
  text: "full text a",
  eli: "https://example.test/a",
  actName: "Obligationenrecht",
  score: 9.5,
};
const RESULT_B: SearchResult = {
  sr: "210",
  article: "1",
  heading: null,
  context: null,
  text: "full text b",
  eli: "https://example.test/b",
  actName: "ZGB",
  score: 4.75,
};

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
});

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    collapsed: false,
    onToggle: vi.fn(),
    conversations: CONVERSATIONS,
    activeId: null,
    onNew: vi.fn(),
    onResume: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(
    <HeroUIProvider>
      <Sidebar {...props} />
    </HeroUIProvider>,
  );
  return props;
}

describe("Sidebar (expanded)", () => {
  it("renders the conversations section heading and list from t()", () => {
    renderSidebar();

    expect(screen.getAllByText("Conversations").length).toBeGreaterThan(0);
    expect(screen.getByText("First chat")).toBeInTheDocument();
    expect(screen.getByText("Untitled conversation")).toBeInTheDocument();
  });

  it("shows a search input with the localized placeholder that updates as the user types", async () => {
    const user = userEvent.setup();
    renderSidebar();

    const searchInput = screen.getByPlaceholderText("Search…");
    await user.type(searchInput, "termination");

    expect(searchInput).toHaveValue("termination");
  });

  it("calls onNew when the new-conversation button is pressed", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();

    await user.click(screen.getByRole("button", { name: "New conversation" }));

    expect(props.onNew).toHaveBeenCalledOnce();
  });

  it("calls onToggle when the collapse button is pressed", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();

    await user.click(screen.getByRole("button", { name: "Conversations" }));

    expect(props.onToggle).toHaveBeenCalledOnce();
  });

  it("focuses and selects the search input when searchFocusSignal is bumped, even without a collapse change", async () => {
    const { rerender } = render(
      <HeroUIProvider>
        <Sidebar
          collapsed={false}
          onToggle={vi.fn()}
          conversations={CONVERSATIONS}
          activeId={null}
          onNew={vi.fn()}
          onResume={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          searchFocusSignal={0}
        />
      </HeroUIProvider>,
    );
    const searchInput = screen.getByPlaceholderText("Search…");
    expect(document.activeElement).not.toBe(searchInput);

    rerender(
      <HeroUIProvider>
        <Sidebar
          collapsed={false}
          onToggle={vi.fn()}
          conversations={CONVERSATIONS}
          activeId={null}
          onNew={vi.fn()}
          onResume={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn()}
          searchFocusSignal={1}
        />
      </HeroUIProvider>,
    );

    expect(document.activeElement).toBe(searchInput);
  });

  it("marks the active conversation with the primary left border", () => {
    renderSidebar({ activeId: "c1" });

    const active = screen.getByText("First chat").closest("li");
    const inactive = screen.getByText("Untitled conversation").closest("li");

    expect(active).toHaveClass("border-l-3", "border-primary");
    expect(inactive).toHaveClass("border-l-3", "border-transparent");
  });

  it("resumes a conversation when its row is pressed", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();

    await user.click(screen.getByText("First chat"));

    expect(props.onResume).toHaveBeenCalledWith("c1");
  });

  it("deletes a conversation through the Popover confirm", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();

    const row = screen.getByText("First chat").closest("li");
    if (row === null) throw new Error("row not found");
    await user.click(within(row).getByRole("button", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete this conversation? This cannot be undone.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(props.onDelete).toHaveBeenCalledWith("c1");
    expect(props.onResume).not.toHaveBeenCalled();
  });

  it("renames a conversation through the Popover input", async () => {
    const user = userEvent.setup();
    const props = renderSidebar();

    const row = screen.getByText("First chat").closest("li");
    if (row === null) throw new Error("row not found");
    await user.click(within(row).getByRole("button", { name: "Rename" }));

    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByDisplayValue("First chat");
    await user.clear(input);
    await user.type(input, "Renamed chat");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    expect(props.onRename).toHaveBeenCalledWith("c1", "Renamed chat");
    expect(props.onResume).not.toHaveBeenCalled();
  });
});

describe("Sidebar (collapsed)", () => {
  it("hides the conversation list and search input, showing only the icon rail", () => {
    renderSidebar({ collapsed: true });

    expect(screen.queryByPlaceholderText("Search…")).not.toBeInTheDocument();
    expect(screen.queryByText("First chat")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeInTheDocument();
  });

  it("calls onToggle from the rail's expand button", async () => {
    const user = userEvent.setup();
    const props = renderSidebar({ collapsed: true });

    await user.click(screen.getByRole("button", { name: "Conversations" }));

    expect(props.onToggle).toHaveBeenCalledOnce();
  });

  it("calls onNew from the rail without expanding first", async () => {
    const user = userEvent.setup();
    const props = renderSidebar({ collapsed: true });

    await user.click(screen.getByRole("button", { name: "New conversation" }));

    expect(props.onNew).toHaveBeenCalledOnce();
  });

  it("focuses the search input once the panel actually expands after the rail's search button is pressed", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <HeroUIProvider>
        <Sidebar
          collapsed={true}
          onToggle={onToggle}
          conversations={CONVERSATIONS}
          activeId={null}
          onNew={vi.fn()}
          onResume={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn()}
        />
      </HeroUIProvider>,
    );

    // The rail's search button and the expanded search input share the same
    // localized name ("Search…") — only the button exists while collapsed.
    await user.click(screen.getByRole("button", { name: "Search…" }));
    expect(onToggle).toHaveBeenCalledOnce();

    // Simulates the parent (App) re-rendering Sidebar with collapsed=false
    // in response to onToggle — the input isn't mounted until this happens.
    rerender(
      <HeroUIProvider>
        <Sidebar
          collapsed={false}
          onToggle={onToggle}
          conversations={CONVERSATIONS}
          activeId={null}
          onNew={vi.fn()}
          onResume={vi.fn()}
          onRename={vi.fn()}
          onDelete={vi.fn()}
        />
      </HeroUIProvider>,
    );

    expect(document.activeElement).toBe(screen.getByPlaceholderText("Search…"));
  });
});

describe("Sidebar search", () => {
  it("debounces: does not call api.search until 300ms after the last keystroke", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.type(screen.getByPlaceholderText("Search…"), "termination");

    expect(searchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(searchMock).toHaveBeenCalled(), { timeout: 1000 });
    expect(searchMock).toHaveBeenCalledWith("termination", 8, "de", expect.any(AbortSignal));
  });

  it("renders SR/article/snippet and a relative score bar for each result", async () => {
    searchMock.mockResolvedValue([RESULT_A, RESULT_B]);
    const user = userEvent.setup();
    renderSidebar();

    await user.type(screen.getByPlaceholderText("Search…"), "frist");

    expect(await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 })).toBeInTheDocument();
    expect(screen.getByText("Kündigungsfrist")).toBeInTheDocument();
    expect(
      screen.getByText("Die Kündigungsfrist beträgt einen Monat während des ersten Dienstjahres."),
    ).toBeInTheDocument();
    expect(screen.getByText("SR 210 · Art. 1")).toBeInTheDocument();

    // A has the higher score (9.5) so its fill reaches 100%; B (4.75) is proportionally half.
    const barA = screen.getByText("SR 220 · Art. 335c").closest("button")?.querySelector(".bg-primary");
    const barB = screen.getByText("SR 210 · Art. 1").closest("button")?.querySelector(".bg-primary");
    expect(barA).toHaveStyle({ width: "100%" });
    expect(barB).toHaveStyle({ width: "50%" });
  });

  it("shows the localized empty state when there are no results", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.type(screen.getByPlaceholderText("Search…"), "nichts");

    expect(await screen.findByText("No results found.", undefined, { timeout: 1000 })).toBeInTheDocument();
  });

  it("shows the localized error state when the search fails", async () => {
    searchMock.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderSidebar();

    await user.type(screen.getByPlaceholderText("Search…"), "fehler");

    expect(
      await screen.findByText("Search failed. Please try again.", undefined, { timeout: 1000 }),
    ).toBeInTheDocument();
  });

  it("clicking a result calls onSearchSelect with that result", async () => {
    searchMock.mockResolvedValue([RESULT_A]);
    const user = userEvent.setup();
    const onSearchSelect = vi.fn();
    renderSidebar({ onSearchSelect });

    await user.type(screen.getByPlaceholderText("Search…"), "frist");
    await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 });
    await user.click(screen.getByText("SR 220 · Art. 335c"));

    expect(onSearchSelect).toHaveBeenCalledWith(RESULT_A);
  });

  it("Enter selects the first result", async () => {
    searchMock.mockResolvedValue([RESULT_A, RESULT_B]);
    const user = userEvent.setup();
    const onSearchSelect = vi.fn();
    renderSidebar({ onSearchSelect });

    const input = screen.getByPlaceholderText("Search…");
    await user.type(input, "frist");
    await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 });
    await user.type(input, "{Enter}");

    expect(onSearchSelect).toHaveBeenCalledWith(RESULT_A);
  });

  it("Enter is a no-op while no results have loaded", async () => {
    const user = userEvent.setup();
    const onSearchSelect = vi.fn();
    renderSidebar({ onSearchSelect });

    const input = screen.getByPlaceholderText("Search…");
    await user.type(input, "frist{Enter}");

    expect(onSearchSelect).not.toHaveBeenCalled();
  });

  it("clearing the input drops the results and shows the conversation list again", async () => {
    searchMock.mockResolvedValue([RESULT_A]);
    const user = userEvent.setup();
    renderSidebar();

    const input = screen.getByPlaceholderText("Search…");
    await user.type(input, "frist");
    await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 });

    await user.clear(input);

    expect(screen.getByText("First chat")).toBeInTheDocument();
    expect(screen.queryByText("SR 220 · Art. 335c")).not.toBeInTheDocument();
  });
});
