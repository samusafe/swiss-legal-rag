import { useEffect, useRef } from "react";

export type ShortcutMap = Record<string, () => void>;

// ctrl+k (search) and ctrl+n (new conversation) are global — they fire even
// while the user is typing in an input/textarea/contenteditable. Every other
// shortcut is suppressed there so plain typing (e.g. "b") never triggers one.
const ALWAYS_ALLOWED = new Set(["ctrl+k", "ctrl+n"]);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  // `isContentEditable` isn't implemented in jsdom, so fall back to the
  // attribute directly — this also covers contenteditable="" (valid HTML).
  return target.isContentEditable || target.getAttribute("contenteditable") === "true"
    || target.getAttribute("contenteditable") === "";
}

// Normalizes to the brief's "ctrl+k" style key. Cmd (metaKey) counts as
// ctrl so the same map works on macOS without a second set of bindings.
function keyFor(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("ctrl");
  if (event.shiftKey) parts.push("shift");
  if (event.altKey) parts.push("alt");
  parts.push(event.key.toLowerCase());
  return parts.join("+");
}

/**
 * Document-level keyboard shortcuts, keyed like `"ctrl+b"`. Registers once
 * per mount (the map is read from a ref, not an effect dependency) so
 * passing a fresh inline object every render doesn't churn the listener.
 */
export function useShortcuts(map: ShortcutMap): void {
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const key = keyFor(event);
      const handler = mapRef.current[key];
      if (handler === undefined) return;
      if (isEditableTarget(event.target) && !ALWAYS_ALLOWED.has(key)) return;
      event.preventDefault();
      handler();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
}
