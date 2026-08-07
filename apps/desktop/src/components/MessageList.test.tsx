import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";

vi.mock("../lib/open", () => ({
  openExternal: vi.fn(),
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
          streaming={false}
          searching={false}
          thinking=""
          selectedIndex={null}
          onSelect={vi.fn()}
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
          streaming={false}
          searching={false}
          thinking=""
          selectedIndex={null}
          onSelect={vi.fn()}
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
          streaming={false}
          searching={false}
          thinking=""
          selectedIndex={null}
          onSelect={vi.fn()}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByText("ollama down")).toBeInTheDocument();
  });

  it("shows the searching indicator in an empty streaming bubble", () => {
    render(
      <HeroUIProvider>
        <MessageList
          messages={[
            { role: "user", text: "q", citations: [], error: null },
            { role: "assistant", text: "", citations: [], error: null },
          ]}
          streaming={true}
          searching={true}
          thinking=""
          selectedIndex={null}
          onSelect={vi.fn()}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByTestId("thinking-indicator")).toBeInTheDocument();
    expect(screen.getByText("Searching articles…")).toBeInTheDocument();
  });

  it("switches the caption to Thinking… once sources arrived", () => {
    render(
      <HeroUIProvider>
        <MessageList
          messages={[{ role: "assistant", text: "", citations: [], error: null }]}
          streaming={true}
          searching={false}
          thinking=""
          selectedIndex={null}
          onSelect={vi.fn()}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("hides the thinking indicator once the last assistant message has text while streaming", () => {
    render(
      <HeroUIProvider>
        <MessageList
          messages={[{ role: "assistant", text: "Ein Monat", citations: [], error: null }]}
          streaming={true}
          searching={false}
          thinking=""
          selectedIndex={null}
          onSelect={vi.fn()}
        />
      </HeroUIProvider>,
    );

    expect(screen.queryByTestId("thinking-indicator")).not.toBeInTheDocument();
  });

  it("renders the stopped note and no indicator once text streamed", () => {
    render(
      <HeroUIProvider>
        <MessageList
          messages={[
            { role: "assistant", text: "Partial ", citations: [], error: null, stopped: true },
          ]}
          streaming={false}
          searching={false}
          thinking=""
          selectedIndex={null}
          onSelect={vi.fn()}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByText("stopped")).toBeInTheDocument();
    expect(screen.queryByTestId("thinking-indicator")).not.toBeInTheDocument();
  });

  it("selects an assistant bubble on click and marks it pressed", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <HeroUIProvider>
        <MessageList
          messages={[
            { role: "user", text: "q", citations: [], error: null },
            { role: "assistant", text: "Antwort.", citations: [], error: null },
          ]}
          streaming={false}
          searching={false}
          thinking=""
          selectedIndex={1}
          onSelect={onSelect}
        />
      </HeroUIProvider>,
    );

    const bubble = screen.getByRole("button", { pressed: true });
    expect(bubble).toHaveTextContent("Antwort.");
    await user.click(bubble);
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(screen.getByText("q")).not.toHaveAttribute("role");
  });

  describe("a11y", () => {
    it("does not nest the thinking disclosure button inside an interactive bubble while streaming", () => {
      render(
        <HeroUIProvider>
          <MessageList
            messages={[{ role: "assistant", text: "", citations: [], error: null }]}
            streaming={true}
            searching={false}
            thinking=""
            selectedIndex={null}
            onSelect={vi.fn()}
          />
        </HeroUIProvider>,
      );

      // Exactly one interactive control in the bubble area: the disclosure toggle.
      expect(screen.getAllByRole("button")).toHaveLength(1);

      const disclosureToggle = screen.getByTestId("thinking-indicator");
      const bubble = disclosureToggle.parentElement?.parentElement;
      expect(bubble).not.toHaveAttribute("role");
      expect(bubble).not.toHaveAttribute("tabindex");
    });
  });

  describe("thinking disclosure", () => {
    it("is collapsed by default and expands on click to show the streamed reasoning", async () => {
      const user = userEvent.setup();
      render(
        <HeroUIProvider>
          <MessageList
            messages={[
              { role: "user", text: "q", citations: [], error: null },
              { role: "assistant", text: "", citations: [], error: null },
            ]}
            streaming={true}
            searching={false}
            thinking="checking Art. 335c…"
            selectedIndex={null}
            onSelect={vi.fn()}
          />
        </HeroUIProvider>,
      );

      const toggle = screen.getByTestId("thinking-indicator");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("checking Art. 335c…")).not.toBeInTheDocument();

      await user.click(toggle);

      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("checking Art. 335c…")).toBeInTheDocument();
    });

    it("shows a placeholder when expanded with no reasoning emitted yet", async () => {
      const user = userEvent.setup();
      render(
        <HeroUIProvider>
          <MessageList
            messages={[
              { role: "user", text: "q", citations: [], error: null },
              { role: "assistant", text: "", citations: [], error: null },
            ]}
            streaming={true}
            searching={true}
            thinking=""
            selectedIndex={null}
            onSelect={vi.fn()}
          />
        </HeroUIProvider>,
      );

      await user.click(screen.getByTestId("thinking-indicator"));

      expect(screen.getByText("No reasoning emitted by this model.")).toBeInTheDocument();
    });
  });
});
