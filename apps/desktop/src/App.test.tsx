import { HeroUIProvider } from "@heroui/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import App from "./App";
import type { SearchResult } from "./lib/api";

// useIngest attaches to the progress stream unconditionally on mount (see
// its own module doc) — every test that mounts App drives this, so the
// default must be a real (empty) async generator, not bare `vi.fn()`
// (calling that returns undefined, and `for await...of undefined` throws).
async function* noIngestEvents() {
  // no events — mirrors the backend's idle-corpus progress/done exchange
}

vi.mock("./lib/api", () => ({
  getHealth: vi.fn().mockResolvedValue(false),
  postChat: vi.fn(),
  search: vi.fn().mockResolvedValue([]),
  fetchArticle: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  getIngestStatus: vi.fn().mockResolvedValue({
    running: false,
    phase: null,
    acts: 0,
    chunksTotal: 0,
    chunksEmbedded: 0,
  }),
  postIngest: vi.fn(),
  postIngestStop: vi.fn(),
  streamIngestProgress: vi.fn().mockImplementation(noIngestEvents),
  SHOW_THINKING: false,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("./lib/db", () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  createConversation: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  appendMessage: vi.fn(),
  getMessages: vi.fn(),
  // lib/audit.ts imports isTauri from here — without it, logAudit() (now
  // wired into App/SearchPalette/ArticleDocModal/SettingsModal) throws
  // calling undefined() and the failure surfaces as an unrelated UI error.
  isTauri: () => false,
}));

import { fetchArticle, search } from "./lib/api";
import type { Article } from "./lib/api";
import { deleteConversation, listConversations, renameConversation } from "./lib/db";
import type { Conversation } from "./lib/db";

const searchMock = vi.mocked(search);
const fetchArticleMock = vi.mocked(fetchArticle);
const listConversationsMock = vi.mocked(listConversations);
const deleteConversationMock = vi.mocked(deleteConversation);
const renameConversationMock = vi.mocked(renameConversation);

const CONVERSATION: Conversation = {
  id: "conv-1",
  title: "Kündigungsfrist?",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
};

const RESULT: SearchResult = {
  sr: "220",
  article: "335c",
  heading: "Kündigungsfrist",
  context: "Die Kündigungsfrist beträgt einen Monat.",
  text: "full text",
  eli: "https://example.test/220",
  actName: "Obligationenrecht",
  score: 9.5,
};

it("renders header, empty-sources hint and a disabled composer while offline", async () => {
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );

  expect(screen.getByText("Swiss Legal RAG")).toBeInTheDocument();
  expect(
    screen.getByText("Ask a question to see the articles behind the answer."),
  ).toBeInTheDocument();
  expect(screen.getByPlaceholderText("The retrieval service is offline.")).toBeDisabled();
  expect(
    await screen.findByText("The corpus is empty. Run ingestion to start asking questions."),
  ).toBeInTheDocument();

  // Three-zone layout: sidebar, chat, sources — all present at once.
  expect(screen.getAllByText("Conversations").length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "New conversation" })).toBeInTheDocument();
  expect(screen.getByText("Sources")).toBeInTheDocument();
});

it("toggles the sources panel with ctrl+j, unmounting it so its controls leave the tab order", async () => {
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );
  await screen.findByText("The corpus is empty. Run ingestion to start asking questions.");
  expect(screen.getByText("Sources")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Expand sources" })).not.toBeInTheDocument();

  fireEvent.keyDown(document, { key: "j", ctrlKey: true });

  expect(screen.queryByText("Sources")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Expand sources" })).toBeInTheDocument();

  fireEvent.keyDown(document, { key: "j", ctrlKey: true });

  expect(screen.getByText("Sources")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Expand sources" })).not.toBeInTheDocument();
});

it("opens the article document modal when a palette search result is selected", async () => {
  searchMock.mockReset();
  searchMock.mockResolvedValue([RESULT]);
  fetchArticleMock.mockReset();
  const article: Article = {
    sr: "220",
    article: "335c",
    lang: "de",
    heading: "Kündigungsfrist",
    actName: "Obligationenrecht",
    abbrev: "OR",
    eli: "https://example.test/220",
    versionDate: "2024-01-01",
    texts: ["Die Kündigungsfrist beträgt einen Monat."],
    availableLangs: ["de"],
  };
  fetchArticleMock.mockResolvedValue(article);
  const user = userEvent.setup();
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );
  await screen.findByText("The corpus is empty. Run ingestion to start asking questions.");

  await user.click(screen.getByRole("button", { name: "Open article search" }));
  await user.type(screen.getByPlaceholderText("Search articles…"), "kündigungsfrist");
  await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 });

  await user.click(screen.getByText("SR 220 · Art. 335c"));

  // Selecting a result closes the palette and opens the article document modal.
  expect(
    await screen.findByText("Die Kündigungsfrist beträgt einen Monat."),
  ).toBeInTheDocument();
  expect(screen.queryByPlaceholderText("Search articles…")).not.toBeInTheDocument();
  expect(fetchArticleMock).toHaveBeenCalledWith("220", "335c", "de", expect.any(AbortSignal));
});

it("opens Settings from the header gear", async () => {
  const user = userEvent.setup();
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );
  await screen.findByText("The corpus is empty. Run ingestion to start asking questions.");

  await user.click(screen.getByRole("button", { name: "Settings" }));

  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "General" })).toBeInTheDocument();
});

it("opens Settings with the Ctrl+, shortcut", async () => {
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );
  await screen.findByText("The corpus is empty. Run ingestion to start asking questions.");

  fireEvent.keyDown(document, { key: ",", ctrlKey: true });

  expect(await screen.findByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Corpus" })).toBeInTheDocument();
});

it("opens the article search palette on Ctrl+K, autofocused, and closes it on a second Ctrl+K", async () => {
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );
  await screen.findByText("The corpus is empty. Run ingestion to start asking questions.");
  expect(screen.queryByPlaceholderText("Search articles…")).not.toBeInTheDocument();

  fireEvent.keyDown(document, { key: "k", ctrlKey: true });

  const searchInput = await screen.findByPlaceholderText("Search articles…");
  await waitFor(() => expect(document.activeElement).toBe(searchInput));

  fireEvent.keyDown(document, { key: "k", ctrlKey: true });

  await waitFor(() =>
    expect(screen.queryByPlaceholderText("Search articles…")).not.toBeInTheDocument(),
  );
});

it("surfaces a rejected conversation delete as a visible error banner", async () => {
  listConversationsMock.mockResolvedValueOnce([CONVERSATION]);
  deleteConversationMock.mockRejectedValueOnce(new Error("disk full"));
  const user = userEvent.setup();
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );
  const row = (await screen.findByText("Kündigungsfrist?")).closest("li");
  if (row === null) throw new Error("row not found");

  await user.click(within(row).getByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
});

it("surfaces a rejected conversation rename as a visible error banner", async () => {
  listConversationsMock.mockResolvedValueOnce([CONVERSATION]);
  renameConversationMock.mockRejectedValueOnce(new Error("disk full"));
  const user = userEvent.setup();
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );
  const row = (await screen.findByText("Kündigungsfrist?")).closest("li");
  if (row === null) throw new Error("row not found");

  await user.click(within(row).getByRole("button", { name: "Rename" }));
  const dialog = await screen.findByRole("dialog");
  const input = within(dialog).getByDisplayValue("Kündigungsfrist?");
  await user.clear(input);
  await user.type(input, "Renamed");
  await user.click(within(dialog).getByRole("button", { name: "Rename" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
});

it("stacks below lg (chat primary, bounded sources, overlay sidebar) but keeps the lg+ 3-column grid", async () => {
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );
  await screen.findByText("The corpus is empty. Run ingestion to start asking questions.");

  const layout = screen.getByTestId("app-layout");
  expect(layout).toHaveClass("flex", "flex-col", "lg:grid", "lg:grid-cols-[auto_1fr_auto]");

  const sourcesColumn = screen.getByTestId("sources-column");
  expect(sourcesColumn).toHaveClass("max-h-56", "overflow-y-auto", "lg:max-h-none");

  // Sidebar overlays instead of consuming width below lg; reverts to a
  // normal in-flow column at lg+. Full stacking/overlay behavior on a real
  // narrow viewport can only be confirmed in `pnpm tauri dev`.
  const sidebar = screen.getByRole("navigation", { name: "Conversations" });
  expect(sidebar).toHaveClass("absolute", "lg:static");
});

it("surfaces a rejected mount-time conversation-list refresh as a visible error banner", async () => {
  listConversationsMock.mockRejectedValueOnce(new Error("disk full"));
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
});
