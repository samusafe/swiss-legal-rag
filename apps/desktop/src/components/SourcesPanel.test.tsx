import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SourcesPanel } from "./SourcesPanel";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

import { openUrl } from "@tauri-apps/plugin-opener";

const SOURCE = {
  sr: "220",
  article: "335c",
  heading: "Kündigungsfristen",
  eli: "https://example.test/e",
  lang: "de",
  score: 6.9,
};

describe("SourcesPanel", () => {
  it("shows SR, heading, lang and score with a Fedlex link", async () => {
    const user = userEvent.setup();
    render(
      <HeroUIProvider>
        <SourcesPanel sources={[SOURCE]} />
      </HeroUIProvider>,
    );

    expect(screen.getByText("SR 220 Art. 335c")).toBeInTheDocument();
    expect(screen.getByText("Kündigungsfristen")).toBeInTheDocument();
    expect(screen.getByText("de")).toBeInTheDocument();
    expect(screen.getByText("score 6.90")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open on Fedlex" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.test/e");
  });

  it("shows the empty hint when there are no sources", () => {
    render(
      <HeroUIProvider>
        <SourcesPanel sources={[]} />
      </HeroUIProvider>,
    );

    expect(
      screen.getByText("Ask a question to see the articles behind the answer."),
    ).toBeInTheDocument();
  });
});
