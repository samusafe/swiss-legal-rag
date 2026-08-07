import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Header } from "./Header";

describe("Header", () => {
  it("reflects online/offline status in the status dot title", () => {
    const { rerender } = render(
      <HeroUIProvider>
        <Header
          online={true}
          lang="de"
          onLangChange={vi.fn()}
          ingestPercent={null}
          onOpenCorpus={vi.fn()}
        />
      </HeroUIProvider>,
    );
    expect(screen.getByTestId("backend-status")).toHaveAttribute(
      "title",
      "retrieval API online",
    );

    rerender(
      <HeroUIProvider>
        <Header
          online={false}
          lang="de"
          onLangChange={vi.fn()}
          ingestPercent={null}
          onOpenCorpus={vi.fn()}
        />
      </HeroUIProvider>,
    );
    expect(screen.getByTestId("backend-status")).toHaveAttribute(
      "title",
      "retrieval API offline",
    );
  });

  it("calls onLangChange('fr') when the FR tab is clicked", async () => {
    const user = userEvent.setup();
    const onLangChange = vi.fn();
    render(
      <HeroUIProvider>
        <Header
          online={true}
          lang="de"
          onLangChange={onLangChange}
          ingestPercent={null}
          onOpenCorpus={vi.fn()}
        />
      </HeroUIProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "FR" }));

    expect(onLangChange).toHaveBeenCalledWith("fr");
  });

  it("labels the language switcher and explains each language on hover", () => {
    render(
      <HeroUIProvider>
        <Header
          online={true}
          lang="de"
          onLangChange={vi.fn()}
          ingestPercent={null}
          onOpenCorpus={vi.fn()}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByText("Answer language")).toBeInTheDocument();
    expect(screen.getByText("DE")).toHaveAttribute("title", "Deutsch");
    expect(screen.getByText("FR")).toHaveAttribute("title", "Français");
    expect(screen.getByText("IT")).toHaveAttribute("title", "Italiano");
  });
});

describe("Header corpus button", () => {
  it("opens the corpus panel on click", async () => {
    const user = userEvent.setup();
    const onOpenCorpus = vi.fn();
    render(
      <HeroUIProvider>
        <Header
          online={true}
          lang="de"
          onLangChange={vi.fn()}
          ingestPercent={null}
          onOpenCorpus={onOpenCorpus}
        />
      </HeroUIProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Corpus" }));
    expect(onOpenCorpus).toHaveBeenCalledOnce();
  });

  it("shows the embed percentage while a run is active", () => {
    render(
      <HeroUIProvider>
        <Header
          online={true}
          lang="de"
          onLangChange={vi.fn()}
          ingestPercent={42}
          onOpenCorpus={vi.fn()}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByRole("button", { name: "Corpus, 42% embedded" })).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });
});
