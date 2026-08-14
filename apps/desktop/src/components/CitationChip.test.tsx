import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, test, vi } from "vitest";
import { CitationChip } from "./CitationChip";

const RESOLVED = {
  raw: "[SR 220 Art. 335c]",
  label: "SR 220 Art. 335c",
  collection: "SR",
  number: "220",
  article: "335c",
  sourceUrl: "https://example.test/e",
  resolved: true,
};
const UNRESOLVED = {
  raw: "[SR 210 Art. 1]",
  label: "SR 210 Art. 1",
  collection: "SR",
  number: "210",
  article: "1",
  sourceUrl: null,
  resolved: false,
};

describe("CitationChip", () => {
  it("renders unresolved citations as plain, non-clickable chips", () => {
    render(
      <HeroUIProvider>
        <CitationChip citation={UNRESOLVED} />
      </HeroUIProvider>,
    );

    expect(screen.getByText("SR 210 Art. 1")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("resolved chip shows label and fires onOpen with its sourceUrl", async () => {
    const citation = {
      raw: "[SR 822.11 Art. 9, SR 822.11 Art. 12]",
      label: "SR 822.11 Art. 9",
      collection: "SR",
      number: "822.11",
      article: "9",
      sourceUrl: "https://www.fedlex.admin.ch/eli/cc/27/example/fr#art_9",
      resolved: true,
    };
    const onOpen = vi.fn();
    render(
      <HeroUIProvider>
        <CitationChip citation={citation} onOpen={onOpen} />
      </HeroUIProvider>,
    );
    const chip = screen.getByRole("button", { name: "SR 822.11 Art. 9" });
    await userEvent.click(chip);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUrl: citation.sourceUrl }),
    );
  });

  it("renders a resolved chip as a button showing its label, without onOpen wired", () => {
    render(
      <HeroUIProvider>
        <CitationChip citation={RESOLVED} />
      </HeroUIProvider>,
    );

    expect(screen.getByRole("button", { name: "SR 220 Art. 335c" })).toBeInTheDocument();
  });
});
