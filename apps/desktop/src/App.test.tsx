import { HeroUIProvider } from "@heroui/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import App from "./App";
import type { ChatEvent, SearchResult } from "./lib/api";

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

import { fetchArticle, getHealth, postChat, search } from "./lib/api";
import type { Article } from "./lib/api";
import { deleteConversation, getMessages, listConversations, renameConversation } from "./lib/db";
import type { Conversation } from "./lib/db";

const searchMock = vi.mocked(search);
const fetchArticleMock = vi.mocked(fetchArticle);
const listConversationsMock = vi.mocked(listConversations);
const deleteConversationMock = vi.mocked(deleteConversation);
const renameConversationMock = vi.mocked(renameConversation);
const getMessagesMock = vi.mocked(getMessages);
const getHealthMock = vi.mocked(getHealth);
const postChatMock = vi.mocked(postChat);

async function* hangingChat(): AsyncGenerator<ChatEvent> {
  // Simulates the slow pre-first-token "Searching articles…" phase (rerank
  // can take minutes): the stream never emits a single event.
  await new Promise<never>(() => {
    /* never resolves for the lifetime of the test */
  });
}

const CONVERSATION: Conversation = {
  id: "conv-1",
  title: "Kündigungsfrist?",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
};

const CONVERSATION_2: Conversation = {
  id: "conv-2",
  title: "Second chat",
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:01.000Z",
};

const RESULT: SearchResult = {
  jurisdiction: "ch",
  collection: "SR",
  number: "220",
  article: "335c",
  heading: "Kündigungsfrist",
  context: "Die Kündigungsfrist beträgt einen Monat.",
  text: "full text",
  sourceUrl: "https://example.test/220",
  actName: "Obligationenrecht",
  score: 9.5,
  citationLabel: "SR 220 Art. 335c",
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
    jurisdiction: "ch",
    collection: "SR",
    number: "220",
    article: "335c",
    lang: "de",
    heading: "Kündigungsfrist",
    actName: "Obligationenrecht",
    abbrev: "OR",
    sourceUrl: "https://example.test/220",
    versionDate: "2024-01-01",
    texts: ["Die Kündigungsfrist beträgt einen Monat."],
    availableLangs: ["de"],
    citationLabel: "SR 220 Art. 335c",
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
  expect(fetchArticleMock).toHaveBeenCalledWith("ch", "220", "335c", "de", expect.any(AbortSignal));
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

it("deleting the OPEN conversation resets the view to the blank new-chat state", async () => {
  listConversationsMock.mockResolvedValueOnce([CONVERSATION]);
  getMessagesMock.mockResolvedValueOnce([
    {
      id: "m1",
      conversationId: "conv-1",
      role: "assistant",
      content: "Ein Monat.",
      sourcesJson: null,
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ]);
  const user = userEvent.setup();
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );

  await user.click(await screen.findByText("Kündigungsfrist?"));
  expect(await screen.findByText("Ein Monat.")).toBeInTheDocument();

  const row = (await screen.findByText("Kündigungsfrist?")).closest("li");
  if (row === null) throw new Error("row not found");
  await user.click(within(row).getByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));

  expect(deleteConversationMock).toHaveBeenCalledWith("conv-1");
  // The deleted conversation's messages must not linger on screen — the
  // view resets to the blank new-chat slate.
  await waitFor(() => expect(screen.queryByText("Ein Monat.")).not.toBeInTheDocument());
});

it("deleting a NON-open conversation leaves the currently viewed conversation untouched", async () => {
  listConversationsMock.mockResolvedValueOnce([CONVERSATION, CONVERSATION_2]);
  getMessagesMock.mockResolvedValueOnce([
    {
      id: "m1",
      conversationId: "conv-1",
      role: "assistant",
      content: "Ein Monat.",
      sourcesJson: null,
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ]);
  const user = userEvent.setup();
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );

  await user.click(await screen.findByText("Kündigungsfrist?"));
  expect(await screen.findByText("Ein Monat.")).toBeInTheDocument();

  const row2 = (await screen.findByText("Second chat")).closest("li");
  if (row2 === null) throw new Error("row not found");
  await user.click(within(row2).getByRole("button", { name: "Delete" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));

  await waitFor(() => expect(deleteConversationMock).toHaveBeenCalledWith("conv-2"));
  // The open conversation (conv-1) was untouched by deleting a different row.
  expect(screen.getByText("Ein Monat.")).toBeInTheDocument();
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

it("matches a [BSG 721.0 Art. 4] citation in a resumed conversation to its source and opens the article", async () => {
  listConversationsMock.mockResolvedValueOnce([CONVERSATION]);
  getMessagesMock.mockResolvedValueOnce([
    {
      id: "m1",
      conversationId: "conv-1",
      role: "assistant",
      content: "Die Bauvorschriften gelten [BSG 721.0 Art. 4].",
      sourcesJson: JSON.stringify([
        {
          jurisdiction: "be",
          collection: "BSG",
          number: "721.0",
          article: "4",
          heading: "Baubewilligung",
          sourceUrl: "https://www.belex.sites.be.ch/app/be/texts_of_law/721.0",
          lang: "de",
          score: 5,
          citationLabel: "BSG 721.0 Art. 4",
        },
      ]),
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ]);
  const article: Article = {
    jurisdiction: "be",
    collection: "BSG",
    number: "721.0",
    article: "4",
    lang: "de",
    heading: "Baubewilligung",
    actName: "Baugesetz",
    abbrev: "BauG",
    sourceUrl: "https://www.belex.sites.be.ch/app/be/texts_of_law/721.0",
    versionDate: "2024-01-01",
    texts: ["Die Bauvorschriften gelten."],
    availableLangs: ["de"],
    citationLabel: "BSG 721.0 Art. 4",
  };
  fetchArticleMock.mockReset();
  fetchArticleMock.mockResolvedValue(article);
  const user = userEvent.setup();
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );

  await user.click(await screen.findByText("Kündigungsfrist?"));
  // Both the message's citation chip and the sources panel's card share the
  // same accessible name (the source's citationLabel) — the chip is the
  // first in DOM order (message list renders before the sources panel).
  const matches = await screen.findAllByRole("button", { name: "BSG 721.0 Art. 4" });
  await user.click(matches[0]);

  expect(await screen.findByText("Die Bauvorschriften gelten.")).toBeInTheDocument();
  expect(fetchArticleMock).toHaveBeenCalledWith("be", "721.0", "4", "de", expect.any(AbortSignal));
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

it("keeps the sidebar dot and disabled composer for a background turn stuck in the pre-first-token phase, across a '+' new-chat navigation", async () => {
  getHealthMock.mockResolvedValue(true);
  listConversationsMock.mockResolvedValueOnce([CONVERSATION]);
  // The conversation was reopened after a restart and already has an
  // interrupted (empty) prior turn — matches the reported repro.
  getMessagesMock.mockResolvedValueOnce([
    {
      id: "m0",
      conversationId: "conv-1",
      role: "assistant",
      content: "",
      sourcesJson: null,
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ]);
  postChatMock.mockImplementation(hangingChat);
  const user = userEvent.setup();
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );

  await user.click(await screen.findByText("Kündigungsfrist?"));
  expect(await screen.findByText("Answer interrupted — send your question again.")).toBeInTheDocument();

  const textbox = await screen.findByPlaceholderText("Ask a question about Swiss federal law…");
  await user.type(textbox, "Second question");
  await user.click(screen.getByRole("button", { name: "Send" }));

  // Confirms the turn is genuinely in the pre-first-token phase before
  // navigating away — mirrors "shows 'Searching articles…' + Stop when
  // viewed" in the report.
  await screen.findByText("Searching articles…");
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "New conversation" }));

  const row = (await screen.findByText("Kündigungsfrist?")).closest("li");
  if (row === null) throw new Error("row not found");
  // EXPECTED (per the spec): the row shows the generating dot and the
  // composer is disabled while a background turn for a different
  // conversation is in flight — even though nothing has streamed yet.
  expect(within(row).getByRole("status", { name: "Generating…" })).toBeInTheDocument();
  expect(screen.getByPlaceholderText("Ask a question about Swiss federal law…")).toBeDisabled();
});
