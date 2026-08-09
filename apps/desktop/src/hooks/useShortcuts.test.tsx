import { renderHook } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShortcuts } from "./useShortcuts";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useShortcuts", () => {
  it("fires the handler on Ctrl+B", () => {
    const onToggle = vi.fn();
    renderHook(() => useShortcuts({ "ctrl+b": onToggle }));

    fireEvent.keyDown(document, { key: "b", ctrlKey: true });

    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("prevents the default browser action on a matched shortcut", () => {
    const onToggle = vi.fn();
    renderHook(() => useShortcuts({ "ctrl+b": onToggle }));

    const event = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true });
    const preventDefault = vi.spyOn(event, "preventDefault");
    document.dispatchEvent(event);

    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("ignores unmatched keys entirely", () => {
    const onToggle = vi.fn();
    renderHook(() => useShortcuts({ "ctrl+b": onToggle }));

    fireEvent.keyDown(document, { key: "x", ctrlKey: true });

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("ignores shortcuts fired from an input, except ctrl+k and ctrl+n", () => {
    const onToggle = vi.fn();
    const onSearch = vi.fn();
    const onNew = vi.fn();
    const input = document.createElement("input");
    document.body.appendChild(input);

    renderHook(() =>
      useShortcuts({ "ctrl+b": onToggle, "ctrl+k": onSearch, "ctrl+n": onNew }),
    );

    fireEvent.keyDown(input, { key: "b", ctrlKey: true });
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(onSearch).toHaveBeenCalledOnce();

    fireEvent.keyDown(input, { key: "n", ctrlKey: true });
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("ignores shortcuts fired from a textarea, except ctrl+k and ctrl+n", () => {
    const onToggle = vi.fn();
    const onSearch = vi.fn();
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    renderHook(() => useShortcuts({ "ctrl+b": onToggle, "ctrl+k": onSearch }));

    fireEvent.keyDown(textarea, { key: "b", ctrlKey: true });
    expect(onToggle).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "k", ctrlKey: true });
    expect(onSearch).toHaveBeenCalledOnce();
  });

  it("ignores shortcuts fired from a contenteditable element, except ctrl+k/ctrl+n", () => {
    const onToggle = vi.fn();
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    document.body.appendChild(div);

    renderHook(() => useShortcuts({ "ctrl+b": onToggle }));

    fireEvent.keyDown(div, { key: "b", ctrlKey: true });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("stops listening after unmount", () => {
    const onToggle = vi.fn();
    const { unmount } = renderHook(() => useShortcuts({ "ctrl+b": onToggle }));

    unmount();
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("always calls the latest handler even without re-subscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ handler }) => useShortcuts({ "ctrl+b": handler }), {
      initialProps: { handler: first },
    });

    rerender({ handler: second });
    fireEvent.keyDown(document, { key: "b", ctrlKey: true });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
