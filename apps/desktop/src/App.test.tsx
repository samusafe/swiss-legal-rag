import { HeroUIProvider } from "@heroui/react";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  openPath: vi.fn(),
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
}));

import { search } from "./lib/api";
import { deleteConversation, listConversations, renameConversation } from "./lib/db";
import type { Conversation } from "./lib/db";

const searchMock = vi.mocked(search);
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

it("opens an ArticlePreview modal, primed from the clicked result, when a sidebar search result is selected", async () => {
  searchMock.mockReset();
  searchMock.mockResolvedValue([RESULT]);
  const user = userEvent.setup();
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );
  await screen.findByText("The corpus is empty. Run ingestion to start asking questions.");

  await user.type(screen.getByPlaceholderText("Search…"), "kündigungsfrist");
  await screen.findByText("SR 220 · Art. 335c", undefined, { timeout: 1000 });
  searchMock.mockClear();

  await user.click(screen.getByText("SR 220 · Art. 335c"));

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Die Kündigungsfrist beträgt einen Monat.")).toBeInTheDocument();
  // The clicked row already carried the match — the preview must reuse it,
  // not re-fetch.
  expect(searchMock).not.toHaveBeenCalled();
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

it("focuses the sidebar search input on Ctrl+K, including when the panel is already expanded", async () => {
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );
  await screen.findByText("The corpus is empty. Run ingestion to start asking questions.");
  // The left panel is expanded by default — this exercises the exact bug
  // case from the review: Ctrl+K on an already-expanded sidebar must still
  // move focus, not just no-op on `panels.left`.
  const searchInput = screen.getByPlaceholderText("Search…");
  expect(document.activeElement).not.toBe(searchInput);

  fireEvent.keyDown(document, { key: "k", ctrlKey: true });

  expect(document.activeElement).toBe(searchInput);
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

it("surfaces a rejected mount-time conversation-list refresh as a visible error banner", async () => {
  listConversationsMock.mockRejectedValueOnce(new Error("disk full"));
  render(
    <HeroUIProvider>
      <App />
    </HeroUIProvider>,
  );

  expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
});
