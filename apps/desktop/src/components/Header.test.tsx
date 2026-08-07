import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Header } from "./Header";

describe("Header", () => {
  it("reflects online/offline status in the status dot title", () => {
    const { rerender } = render(
      <HeroUIProvider>
        <Header online={true} ingestPercent={null} onOpenCorpus={vi.fn()} />
      </HeroUIProvider>,
    );
    expect(screen.getByTestId("backend-status")).toHaveAttribute(
      "title",
      "retrieval API online",
    );

    rerender(
      <HeroUIProvider>
        <Header online={false} ingestPercent={null} onOpenCorpus={vi.fn()} />
      </HeroUIProvider>,
    );
    expect(screen.getByTestId("backend-status")).toHaveAttribute(
      "title",
      "retrieval API offline",
    );
  });

  it("does not render a language switcher", () => {
    render(
      <HeroUIProvider>
        <Header online={true} ingestPercent={null} onOpenCorpus={vi.fn()} />
      </HeroUIProvider>,
    );

    expect(screen.queryByText("Answer language")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "FR" })).not.toBeInTheDocument();
  });
});

describe("Header corpus button", () => {
  it("opens the corpus panel on click", async () => {
    const user = userEvent.setup();
    const onOpenCorpus = vi.fn();
    render(
      <HeroUIProvider>
        <Header online={true} ingestPercent={null} onOpenCorpus={onOpenCorpus} />
      </HeroUIProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Corpus" }));
    expect(onOpenCorpus).toHaveBeenCalledOnce();
  });

  it("shows the embed percentage while a run is active", () => {
    render(
      <HeroUIProvider>
        <Header online={true} ingestPercent={42} onOpenCorpus={vi.fn()} />
      </HeroUIProvider>,
    );

    expect(screen.getByRole("button", { name: "Corpus, 42% embedded" })).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });
});
