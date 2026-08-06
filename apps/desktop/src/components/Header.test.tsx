import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Header } from "./Header";

describe("Header", () => {
  it("reflects online/offline status in the status dot title", () => {
    const { rerender } = render(
      <HeroUIProvider>
        <Header online={true} lang="de" onLangChange={vi.fn()} />
      </HeroUIProvider>,
    );
    expect(screen.getByTestId("backend-status")).toHaveAttribute(
      "title",
      "retrieval API online",
    );

    rerender(
      <HeroUIProvider>
        <Header online={false} lang="de" onLangChange={vi.fn()} />
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
        <Header online={true} lang="de" onLangChange={onLangChange} />
      </HeroUIProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "FR" }));

    expect(onLangChange).toHaveBeenCalledWith("fr");
  });
});
