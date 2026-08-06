import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver; HeroUI's Tabs uses one to animate the
// selected-tab indicator. A no-op stub is enough for tests.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
