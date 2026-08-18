import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver; HeroUI's Tabs uses one to animate the
// selected-tab indicator. A no-op stub is enough for tests.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom has no window.matchMedia; useTheme() now runs unconditionally inside
// App, so every test that mounts App hits this. A no-op "never matches" stub
// is enough — tests that need real change events (useTheme.test.tsx) install
// their own richer mock, which shadows this one.
function matchMediaStub(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaQueryList;
}
window.matchMedia ??= matchMediaStub;

// jsdom has no scrollIntoView; MessageList calls it to jump to the newest
// message on conversation open/switch. A no-op stub is enough for tests that
// don't care about scrolling — tests that do spy on it explicitly.
Element.prototype.scrollIntoView ??= () => {};
