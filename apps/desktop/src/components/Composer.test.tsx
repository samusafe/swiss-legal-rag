import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

describe("Composer", () => {
  it("calls onSend with trimmed text and clears the draft on Send click", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <HeroUIProvider>
        <Composer disabled={false} offline={false} streaming={false} onSend={onSend} onStop={vi.fn()} />
      </HeroUIProvider>,
    );

    const textbox = screen.getByRole("textbox");
    await user.type(textbox, "  Kündigungsfrist?  ");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledWith("Kündigungsfrist?");
    expect(textbox).toHaveValue("");
  });

  it("submits on Enter", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <HeroUIProvider>
        <Composer disabled={false} offline={false} streaming={false} onSend={onSend} onStop={vi.fn()} />
      </HeroUIProvider>,
    );

    await user.type(screen.getByRole("textbox"), "question{Enter}");

    expect(onSend).toHaveBeenCalledWith("question");
  });

  it("does not submit on Shift+Enter", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <HeroUIProvider>
        <Composer disabled={false} offline={false} streaming={false} onSend={onSend} onStop={vi.fn()} />
      </HeroUIProvider>,
    );

    await user.type(screen.getByRole("textbox"), "question{Shift>}{Enter}{/Shift}");

    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not submit an empty or whitespace-only draft", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <HeroUIProvider>
        <Composer disabled={false} offline={false} streaming={false} onSend={onSend} onStop={vi.fn()} />
      </HeroUIProvider>,
    );

    await user.type(screen.getByRole("textbox"), "   ");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).not.toHaveBeenCalled();
  });

  it("blocks submit and disables the button when disabled", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(
      <HeroUIProvider>
        <Composer disabled={true} offline={false} streaming={false} onSend={onSend} onStop={vi.fn()} />
      </HeroUIProvider>,
    );

    const button = screen.getByRole("button", { name: "Send" });
    expect(button).toBeDisabled();

    await user.click(button);

    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows Stop instead of Send while streaming and calls onStop", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    render(
      <HeroUIProvider>
        <Composer
          disabled={true}
          offline={false}
          streaming={true}
          onSend={vi.fn()}
          onStop={onStop}
        />
      </HeroUIProvider>,
    );

    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("shows Send when not streaming", () => {
    render(
      <HeroUIProvider>
        <Composer
          disabled={false}
          offline={false}
          streaming={false}
          onSend={vi.fn()}
          onStop={vi.fn()}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });
});
