import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CorpusModal } from "./CorpusModal";

const STATUS = {
  running: false,
  phase: null,
  acts: 10,
  chunksTotal: 12930,
  chunksEmbedded: 5420,
};

function renderModal(overrides: Partial<Parameters<typeof CorpusModal>[0]> = {}) {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    status: STATUS,
    progress: null,
    running: false,
    error: null,
    onStart: vi.fn(),
    ...overrides,
  };
  render(
    <HeroUIProvider>
      <CorpusModal {...props} />
    </HeroUIProvider>,
  );
  return props;
}

describe("CorpusModal", () => {
  it("shows corpus stats and triggers onStart", async () => {
    const user = userEvent.setup();
    const props = renderModal();

    expect(
      screen.getByText("10 acts · 12930 articles · 5420 embedded"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Update corpus" }));
    expect(props.onStart).toHaveBeenCalledOnce();
  });

  it("disables the button and shows the labelled bar while running", () => {
    renderModal({ running: true, progress: { phase: "embed", done: 5420, total: 12930 } });

    expect(screen.getByRole("button", { name: "Update corpus" })).toBeDisabled();
    expect(screen.getByText("embed · 42%")).toBeInTheDocument();
  });

  it("shows the error detail verbatim", () => {
    renderModal({ error: "`ingest fetch` failed (exit 1): BOOM" });

    expect(screen.getByText("`ingest fetch` failed (exit 1): BOOM")).toBeInTheDocument();
  });

  it("always shows the chat-stays-usable note", () => {
    renderModal();

    expect(
      screen.getByText("Chat stays usable — results may be incomplete while embedding."),
    ).toBeInTheDocument();
  });

  it("shows the live embedded count from progress during the embed phase", () => {
    renderModal({
      running: true,
      progress: { phase: "embed", done: 6000, total: 12930 },
    });

    expect(screen.getByText("10 acts · 12930 articles · 6000 embedded")).toBeInTheDocument();
  });
});
