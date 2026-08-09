import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { useIngest } from "../hooks/useIngest";
import { CorpusPanel } from "./CorpusPanel";

const STATUS = {
  running: false,
  phase: null,
  acts: 10,
  chunksTotal: 12930,
  chunksEmbedded: 5420,
};

function makeIngest(
  overrides: Partial<ReturnType<typeof useIngest>> = {},
): ReturnType<typeof useIngest> {
  return {
    status: STATUS,
    progress: null,
    running: false,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  };
}

function renderPanel(overrides: Partial<ReturnType<typeof useIngest>> = {}) {
  const ingest = makeIngest(overrides);
  render(
    <HeroUIProvider>
      <CorpusPanel ingest={ingest} />
    </HeroUIProvider>,
  );
  return ingest;
}

describe("CorpusPanel", () => {
  it("shows corpus stats and triggers start via the ingest hook", async () => {
    const user = userEvent.setup();
    const ingest = renderPanel();

    expect(
      screen.getByText("10 acts · 12930 articles · 5420 embedded"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run ingestion" }));
    expect(ingest.start).toHaveBeenCalledOnce();
  });

  it("disables the button and shows the labelled bar while running", () => {
    renderPanel({ running: true, progress: { phase: "embed", done: 5420, total: 12930 } });

    expect(screen.getByRole("button", { name: "Run ingestion" })).toBeDisabled();
    expect(screen.getByText("embed · 42%")).toBeInTheDocument();
  });

  it("shows the error detail verbatim", () => {
    renderPanel({ error: "`ingest fetch` failed (exit 1): BOOM" });

    expect(screen.getByText("`ingest fetch` failed (exit 1): BOOM")).toBeInTheDocument();
  });

  it("always shows the chat-stays-usable note", () => {
    renderPanel();

    expect(
      screen.getByText("Chat stays usable — results may be incomplete while embedding."),
    ).toBeInTheDocument();
  });

  it("shows the live embedded count from progress during the embed phase", () => {
    renderPanel({
      running: true,
      progress: { phase: "embed", done: 6000, total: 12930 },
    });

    expect(screen.getByText("10 acts · 12930 articles · 6000 embedded")).toBeInTheDocument();
  });

  it("shows the progress bar immediately for a reattached run (seeded before the first live event)", () => {
    renderPanel({
      status: { ...STATUS, running: true, phase: "embed" },
      running: true,
      progress: { phase: "embed", done: 5420, total: 12930 }, // seeded by useIngest from the status snapshot
    });

    expect(screen.getByText("embed · 42%")).toBeInTheDocument();
  });

  it("does not show a Stop button while idle", () => {
    renderPanel({ running: false });

    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("shows a Stop button while running, confirms, then calls the stop endpoint", async () => {
    const user = userEvent.setup();
    const ingest = renderPanel({
      running: true,
      progress: { phase: "embed", done: 100, total: 200 },
    });

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(
      screen.getByText(
        "Stop the running ingestion? Progress so far is kept, but the current phase is aborted.",
      ),
    ).toBeInTheDocument();
    expect(ingest.stop).not.toHaveBeenCalled();

    const confirmButtons = screen.getAllByRole("button", { name: "Stop" });
    await user.click(confirmButtons[confirmButtons.length - 1]);

    expect(ingest.stop).toHaveBeenCalledOnce();
  });
});
