import { HeroUIProvider } from "@heroui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ThemePref } from "../hooks/useTheme";
import { Header } from "./Header";

function renderHeader(theme: ThemePref, setTheme = vi.fn()) {
  return render(
    <HeroUIProvider>
      <Header
        online={true}
        ingestPercent={null}
        onOpenSettings={vi.fn()}
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
          theme="system"
          setTheme={vi.fn()}
        />
      </HeroUIProvider>,
    );

    expect(screen.getByRole("button", { name: "Settings, 42% embedded" })).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });
});

describe("Header theme toggle", () => {
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

  it("cycles system -> light on click", async () => {
    const user = userEvent.setup();
    const setTheme = vi.fn();
    renderHeader("system", setTheme);

    await user.click(screen.getByRole("button", { name: "Theme: System" }));
    expect(setTheme).toHaveBeenCalledExactlyOnceWith("light");
  });

  it("cycles light -> dark on click", async () => {
    const user = userEvent.setup();
    const setTheme = vi.fn();
    renderHeader("light", setTheme);

    await user.click(screen.getByRole("button", { name: "Theme: Light" }));
    expect(setTheme).toHaveBeenCalledExactlyOnceWith("dark");
  });

  it("cycles dark -> system on click", async () => {
    const user = userEvent.setup();
    const setTheme = vi.fn();
    renderHeader("dark", setTheme);

    await user.click(screen.getByRole("button", { name: "Theme: Dark" }));
    expect(setTheme).toHaveBeenCalledExactlyOnceWith("system");
  });

  it("places the theme toggle before the settings button, right-aligned as a pair", () => {
    renderHeader("system");
    const buttons = screen.getAllByRole("button");
    const themeIndex = buttons.findIndex((b) => b.getAttribute("aria-label") === "Theme: System");
    const settingsIndex = buttons.findIndex((b) => b.getAttribute("aria-label") === "Settings");
    expect(themeIndex).toBeGreaterThanOrEqual(0);
    expect(settingsIndex).toBeGreaterThan(themeIndex);
  });
});
