import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

const RESOLVED = {
  raw: "[SR 220 Art. 335c]",
  sr: "220",
  article: "335c",
  eli: "https://example.test/e",
  resolved: true,
};
const UNRESOLVED = {
  raw: "[SR 210 Art. 1]",
  sr: "210",
  article: "1",
  eli: null,
  resolved: false,
};

describe("MessageList", () => {
  it("renders resolved citations as buttons and unresolved as plain text chips", () => {
    render(
      <HeroUIProvider>
        <MessageList
          messages={[
            {
              role: "assistant",
              text: "A [SR 220 Art. 335c] B [SR 210 Art. 1]",
              citations: [RESOLVED, UNRESOLVED],
              error: null,
            },
          ]}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByRole("button", { name: "[SR 220 Art. 335c]" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "[SR 210 Art. 1]" })).not.toBeInTheDocument();
    expect(screen.getByText("[SR 210 Art. 1]")).toBeInTheDocument();
  });

  it("renders user and assistant bubbles in order", () => {
    render(
      <HeroUIProvider>
        <MessageList
          messages={[
            { role: "user", text: "Frage?", citations: [], error: null },
            { role: "assistant", text: "Antwort.", citations: [], error: null },
          ]}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByText("Frage?")).toBeInTheDocument();
    expect(screen.getByText("Antwort.")).toBeInTheDocument();
  });

  it("shows the per-message error", () => {
    render(
      <HeroUIProvider>
        <MessageList
          messages={[{ role: "assistant", text: "partial", citations: [], error: "ollama down" }]}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByText("ollama down")).toBeInTheDocument();
  });
});
