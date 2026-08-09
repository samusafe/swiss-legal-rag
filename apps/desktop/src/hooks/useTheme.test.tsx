import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

function mockMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  let matches = initialMatches;
  const mql = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: vi.fn((_event: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.add(cb);
    }),
    removeEventListener: vi.fn((_event: string, cb: (e: MediaQueryListEvent) => void) => {
      listeners.delete(cb);
    }),
  } as unknown as MediaQueryList;

  window.matchMedia = vi.fn().mockReturnValue(mql);

  return {
    setMatches(value: boolean) {
      matches = value;
      listeners.forEach((cb) => cb({ matches: value } as MediaQueryListEvent));
    },
  };
}

function Probe() {
  const { theme, resolved, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolved}</span>
      <button onClick={() => setTheme("dark")}>dark</button>
      <button onClick={() => setTheme("light")}>light</button>
      <button onClick={() => setTheme("system")}>system</button>
    </div>
  );
}

describe("useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to system and resolves from matchMedia", () => {
    mockMatchMedia(true);
    render(<Probe />);

    expect(screen.getByTestId("theme").textContent).toBe("system");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
    expect(document.documentElement.className).toBe("chancery-dark dark");
  });

  it("setTheme('dark') applies chancery-dark dark and persists to localStorage", () => {
    mockMatchMedia(false);
    render(<Probe />);

    act(() => {
      screen.getByText("dark").click();
    });

    expect(document.documentElement.className).toBe("chancery-dark dark");
    expect(localStorage.getItem("slr.theme")).toBe("dark");
  });

  it("setTheme('light') applies chancery-light light and persists to localStorage", () => {
    mockMatchMedia(true);
    render(<Probe />);

    act(() => {
      screen.getByText("light").click();
    });

    expect(document.documentElement.className).toBe("chancery-light light");
    expect(localStorage.getItem("slr.theme")).toBe("light");
  });

  it("setTheme('system') follows the matchMedia mock, including live changes", () => {
    const media = mockMatchMedia(false);
    render(<Probe />);

    act(() => {
      screen.getByText("dark").click();
    });
    expect(document.documentElement.className).toBe("chancery-dark dark");

    act(() => {
      screen.getByText("system").click();
    });
    expect(localStorage.getItem("slr.theme")).toBe("system");
    expect(document.documentElement.className).toBe("chancery-light light");
    expect(screen.getByTestId("resolved").textContent).toBe("light");

    act(() => {
      media.setMatches(true);
    });
    expect(document.documentElement.className).toBe("chancery-dark dark");
    expect(screen.getByTestId("resolved").textContent).toBe("dark");
  });
});
