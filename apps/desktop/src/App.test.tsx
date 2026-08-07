import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import App from "./App";

vi.mock("./lib/api", () => ({
  getHealth: vi.fn().mockResolvedValue(false),
  postChat: vi.fn(),
  getIngestStatus: vi.fn().mockResolvedValue({
    running: false,
    phase: null,
    acts: 0,
    chunksTotal: 0,
    chunksEmbedded: 0,
  }),
  postIngest: vi.fn(),
  streamIngestProgress: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

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
  expect(
    screen.getByPlaceholderText("Start the retrieval API to ask questions"),
  ).toBeDisabled();
  expect(
    await screen.findByText("Corpus not embedded — open the Corpus panel."),
  ).toBeInTheDocument();
});
