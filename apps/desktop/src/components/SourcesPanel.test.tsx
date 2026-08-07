import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SourcesPanel } from "./SourcesPanel";

vi.mock("../lib/open", () => ({
  openExternal: vi.fn(),
}));

import { openExternal } from "../lib/open";

const SOURCE = {
  sr: "220",
  article: "335c",
  heading: "Kündigungsfristen",
  eli: "https://example.test/e",
  lang: "de",
  score: 6.9,
};
const CITATION = {
  raw: "[SR 220 Art. 335c]",
  sr: "220",
  article: "335c",
  eli: "https://example.test/e",
  resolved: true,
};

describe("SourcesPanel", () => {
  it("shows SR, heading, uppercase lang, raw score and a Fedlex link", async () => {
    const user = userEvent.setup();
    render(
      <HeroUIProvider>
        <SourcesPanel sources={[SOURCE]} streaming={false} citations={[]} subtitle="latest answer" />
      </HeroUIProvider>,
    );

    expect(screen.getByText("SR 220 · Art. 335c")).toBeInTheDocument();
    expect(screen.getByText("Kündigungsfristen")).toBeInTheDocument();
    expect(screen.getByText("DE")).toBeInTheDocument();
    expect(screen.getByText("6.90")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open on Fedlex" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.test/e");
  });

  it("shows the empty state with the hint when idle", () => {
    render(
      <HeroUIProvider>
        <SourcesPanel sources={[]} streaming={false} citations={[]} subtitle="latest answer" />
      </HeroUIProvider>,
    );

    expect(
      screen.getByText("Ask a question to see the articles behind the answer."),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId("source-skeleton")).toHaveLength(0);
  });

  it("shows skeleton cards while streaming with no sources yet", () => {
    render(
      <HeroUIProvider>
        <SourcesPanel sources={[]} streaming={true} citations={[]} subtitle="latest answer" />
      </HeroUIProvider>,
    );

    expect(screen.getAllByTestId("source-skeleton")).toHaveLength(5);
    expect(
      screen.queryByText("Ask a question to see the articles behind the answer."),
    ).not.toBeInTheDocument();
  });

  it("dedupes same (sr, article, lang) keeping the highest score", () => {
    render(
      <HeroUIProvider>
        <SourcesPanel
          sources={[SOURCE, { ...SOURCE, score: 7.4 }]}
          streaming={false}
          citations={[]}
          subtitle="latest answer"
        />
      </HeroUIProvider>,
    );

    expect(screen.getAllByText("SR 220 · Art. 335c")).toHaveLength(1);
    expect(screen.getByText("7.40")).toBeInTheDocument();
    expect(screen.getByText("1 article")).toBeInTheDocument();
  });

  it("marks cited sources with a Cited chip", () => {
    render(
      <HeroUIProvider>
        <SourcesPanel
          sources={[SOURCE, { ...SOURCE, article: "1", score: 2.0 }]}
          streaming={false}
          citations={[CITATION]}
          subtitle="latest answer"
        />
      </HeroUIProvider>,
    );

    expect(screen.getAllByText("Cited")).toHaveLength(1);
    expect(screen.getByText("2 articles")).toBeInTheDocument();
  });

  it("renders the relevance bar relative to the result set", () => {
    render(
      <HeroUIProvider>
        <SourcesPanel
          sources={[SOURCE, { ...SOURCE, article: "1", score: 2.0 }]}
          streaming={false}
          citations={[]}
          subtitle="latest answer"
        />
      </HeroUIProvider>,
    );

    const bars = screen.getAllByRole("progressbar");
    expect(bars[0]).toHaveAttribute("aria-valuenow", "100");
    expect(bars[1]).toHaveAttribute("aria-valuenow", "0");
  });

  it("shows the given subtitle", () => {
    render(
      <HeroUIProvider>
        <SourcesPanel sources={[]} streaming={false} citations={[]} subtitle="answer 2" />
      </HeroUIProvider>,
    );

    expect(screen.getByText("answer 2")).toBeInTheDocument();
  });
});
