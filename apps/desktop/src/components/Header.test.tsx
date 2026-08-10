import { HeroUIProvider } from "@heroui/react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ThemePref } from "../hooks/useTheme";
import { Header } from "./Header";

function renderHeader(theme: ThemePref, setTheme = vi.fn(), onOpenSearch = vi.fn()) {
  return render(
    <HeroUIProvider>
      <Header
        online={true}
        ingestPercent={null}
        onOpenSettings={vi.fn()}
        onOpenSearch={onOpenSearch}
        theme={theme}
        setTheme={setTheme}
      />
    </HeroUIProvider>,
  );
}

describe("Header", () => {
  it("reflects online/offline status in the status dot title", () => {
    const { rerender } = render(
      <HeroUIProvider>
        <Header
          online={true}
          ingestPercent={null}
          onOpenSettings={vi.fn()}
          onOpenSearch={vi.fn()}
          theme="system"
          setTheme={vi.fn()}
        />
      </HeroUIProvider>,
    );
    expect(screen.getByTestId("backend-status")).toHaveAttribute("title", "Online");

    rerender(
      <HeroUIProvider>
        <Header
          online={false}
          ingestPercent={null}
          onOpenSettings={vi.fn()}
          onOpenSearch={vi.fn()}
          theme="system"
          setTheme={vi.fn()}
        />
      </HeroUIProvider>,
    );
    expect(screen.getByTestId("backend-status")).toHaveAttribute("title", "Offline");
  });

  it("does not render a language switcher", () => {
    renderHeader("system");

    expect(screen.queryByText("Answer language")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "FR" })).not.toBeInTheDocument();
  });
});

describe("Header settings button", () => {
  it("opens the settings modal on click", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <HeroUIProvider>
        <Header
          online={true}
          ingestPercent={null}
          onOpenSettings={onOpenSettings}
          onOpenSearch={vi.fn()}
          theme="system"
          setTheme={vi.fn()}
        />
      </HeroUIProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("shows the embed percentage while a run is active", () => {
    render(
      <HeroUIProvider>
        <Header
          online={true}
          ingestPercent={42}
          onOpenSettings={vi.fn()}
          onOpenSearch={vi.fn()}
          theme="system"
          setTheme={vi.fn()}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByRole("button", { name: "Settings, 42% embedded" })).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });
});

describe("Header search trigger", () => {
  it("renders the localized placeholder and a Ctrl+K hint, and calls onOpenSearch on click", async () => {
    const user = userEvent.setup();
    const onOpenSearch = vi.fn();
    renderHeader("system", vi.fn(), onOpenSearch);

    const trigger = screen.getByRole("button", { name: "Open article search" });
    expect(within(trigger).getByText("Search articles…")).toBeInTheDocument();
    expect(within(trigger).getByText("Ctrl+K")).toBeInTheDocument();

    await user.click(trigger);

    expect(onOpenSearch).toHaveBeenCalledOnce();
  });

  it("sits between the status dot and the theme dropdown in the button order", () => {
    renderHeader("system");
    const buttons = screen.getAllByRole("button");
    const searchIndex = buttons.findIndex(
      (b) => b.getAttribute("aria-label") === "Open article search",
    );
    const themeIndex = buttons.findIndex((b) => b.getAttribute("aria-label") === "Theme: System");
    expect(searchIndex).toBeGreaterThanOrEqual(0);
    expect(themeIndex).toBeGreaterThan(searchIndex);
  });
});

describe("Header theme dropdown", () => {
  it("shows 'Theme: System' and a monitor icon for the system state", () => {
    renderHeader("system");
    expect(screen.getByRole("button", { name: "Theme: System" })).toBeInTheDocument();
  });

  it("shows 'Theme: Light' for the light state", () => {
    renderHeader("light");
    expect(screen.getByRole("button", { name: "Theme: Light" })).toBeInTheDocument();
  });

  it("shows 'Theme: Dark' for the dark state", () => {
    renderHeader("dark");
    expect(screen.getByRole("button", { name: "Theme: Dark" })).toBeInTheDocument();
  });

  it("opens the menu and calls setTheme('system') when System is chosen", async () => {
    const user = userEvent.setup();
    const setTheme = vi.fn();
    renderHeader("dark", setTheme);

    await user.click(screen.getByRole("button", { name: "Theme: Dark" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "System" }));

    expect(setTheme).toHaveBeenCalledExactlyOnceWith("system");
  });

  it("opens the menu and calls setTheme('light') when Light is chosen", async () => {
    const user = userEvent.setup();
    const setTheme = vi.fn();
    renderHeader("dark", setTheme);

    await user.click(screen.getByRole("button", { name: "Theme: Dark" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Light" }));

    expect(setTheme).toHaveBeenCalledExactlyOnceWith("light");
  });

  it("opens the menu and calls setTheme('dark') when Dark is chosen", async () => {
    const user = userEvent.setup();
    const setTheme = vi.fn();
    renderHeader("system", setTheme);

    await user.click(screen.getByRole("button", { name: "Theme: System" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));

    expect(setTheme).toHaveBeenCalledExactlyOnceWith("dark");
  });

  it("marks the active theme as checked in the menu", async () => {
    const user = userEvent.setup();
    renderHeader("light");

    await user.click(screen.getByRole("button", { name: "Theme: Light" }));

    expect(await screen.findByRole("menuitemradio", { name: "Light" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "System" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("places the theme dropdown before the settings button, right-aligned as a pair", () => {
    renderHeader("system");
    const buttons = screen.getAllByRole("button");
    const themeIndex = buttons.findIndex((b) => b.getAttribute("aria-label") === "Theme: System");
    const settingsIndex = buttons.findIndex((b) => b.getAttribute("aria-label") === "Settings");
    expect(themeIndex).toBeGreaterThanOrEqual(0);
    expect(settingsIndex).toBeGreaterThan(themeIndex);
  });
});
