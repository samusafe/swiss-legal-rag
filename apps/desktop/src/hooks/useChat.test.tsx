import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../lib/api";
import { useChat } from "./useChat";

vi.mock("../lib/api", () => ({
  postChat: vi.fn(),
}));

import { postChat } from "../lib/api";

const postChatMock = vi.mocked(postChat);

async function* events(list: ChatEvent[]): AsyncGenerator<ChatEvent> {
  for (const event of list) yield event;
}

const SOURCE = {
  sr: "220",
  article: "335c",
  heading: "h",
  eli: "https://example.test/e",
  lang: "de",
  score: 6.9,
};
const CITATION = {
  raw: "[SR 220 Art. 335c]",
  sr: "220",
  article: "335c",
  eli: "https://example.test/e",
  resolved: true,
};

describe("useChat", () => {
  beforeEach(() => {
    postChatMock.mockReset();
  });

  it("builds the transcript from sources, token and done events", async () => {
    postChatMock.mockReturnValue(
      events([
        { type: "sources", sources: [SOURCE] },
        { type: "token", delta: "Die Frist " },
        { type: "token", delta: "beträgt einen Monat [SR 220 Art. 335c]." },
        { type: "done", citations: [CITATION], model: "m", durationMs: 1 },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("Kündigungsfrist?");
    });

    expect(result.current.messages).toEqual([
      { role: "user", text: "Kündigungsfrist?", citations: [], error: null },
      {
        role: "assistant",
        text: "Die Frist beträgt einen Monat [SR 220 Art. 335c].",
        citations: [CITATION],
        error: null,
        sources: [SOURCE],
      },
    ]);
    expect(result.current.sources).toEqual([SOURCE]);
    expect(result.current.streaming).toBe(false);
    expect(result.current.banner).toBeNull();
  });

  it("attaches the answer's sources to the assistant message", async () => {
    postChatMock.mockReturnValue(
      events([
        { type: "sources", sources: [SOURCE] },
        { type: "token", delta: "x" },
      ]),
    );
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.send("q");
    });
    expect(result.current.messages.at(-1)?.sources).toEqual([SOURCE]);
  });

  it("keeps partial text and flags the message on a mid-stream error event", async () => {
    postChatMock.mockReturnValue(
      events([
        { type: "token", delta: "Partial" },
        { type: "error", detail: "ollama down" },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "Partial",
      error: "ollama down",
    });
    expect(result.current.banner).toBeNull();
    expect(result.current.streaming).toBe(false);
  });

  it("sets the banner and drops the empty bubble when the request fails", async () => {
    postChatMock.mockImplementation(async function* () {
      throw new Error("database unavailable at localhost:5432");
    });
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.banner).toBe("database unavailable at localhost:5432");
    expect(result.current.messages).toEqual([
      { role: "user", text: "q", citations: [], error: null },
    ]);
    expect(result.current.streaming).toBe(false);
  });

  it("calls postChat with only the question and an abort signal", async () => {
    postChatMock.mockReturnValue(events([]));
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(postChatMock).toHaveBeenCalledWith("q", expect.any(AbortSignal));
  });

  it("accumulates thinking deltas into a transient reasoning string, cleared once tokens start", async () => {
    let resolveThinking: (() => void) | undefined;
    postChatMock.mockImplementation(async function* (_question: string, _signal: AbortSignal) {
      yield { type: "thinking", delta: "checking Art. 335c… " } as const;
      yield { type: "thinking", delta: "one month notice." } as const;
      await new Promise<void>((resolve) => {
        resolveThinking = resolve;
      });
      yield { type: "token", delta: "Ein Monat" } as const;
    });
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() =>
      expect(result.current.thinking).toBe("checking Art. 335c… one month notice."),
    );

    act(() => resolveThinking?.());
    await act(async () => {
      await pending;
    });

    expect(result.current.thinking).toBe("");
  });

  it("clears thinking when a new send starts", async () => {
    postChatMock.mockReturnValueOnce(
      events([{ type: "thinking", delta: "reasoning…" } as ChatEvent]),
    );
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.send("one");
    });
    expect(result.current.thinking).toBe("reasoning…");

    postChatMock.mockReturnValueOnce(events([]));
    await act(async () => {
      await result.current.send("two");
    });

    expect(result.current.thinking).toBe("");
  });

  it("clears sources when a new send starts", async () => {
    postChatMock.mockReturnValueOnce(events([{ type: "sources", sources: [SOURCE] }]));
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("one");
    });
    expect(result.current.sources).toEqual([SOURCE]);

    postChatMock.mockReturnValueOnce(events([]));
    await act(async () => {
      await result.current.send("two");
    });

    expect(result.current.sources).toEqual([]);
  });

  it("ignores a second send while one is in flight", async () => {
    let release: (() => void) | undefined;
    postChatMock.mockImplementation(async function* () {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield { type: "token", delta: "x" } as const;
    });
    const { result } = renderHook(() => useChat());

    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.send("one");
    });
    await act(async () => {
      await result.current.send("two");
    });

    expect(result.current.messages.filter((m) => m.role === "user")).toHaveLength(1);

    act(() => release?.());
    await act(async () => {
      await first;
    });
  });

  it("stop() with no in-flight run is a safe no-op, including called twice", () => {
    const { result } = renderHook(() => useChat());

    expect(() => {
      act(() => {
        result.current.stop();
      });
    }).not.toThrow();
    expect(() => {
      act(() => {
        result.current.stop();
      });
    }).not.toThrow();

    expect(result.current.messages).toEqual([]);
    expect(result.current.banner).toBeNull();
  });

  it("stop() keeps the partial text, marks it stopped and shows no banner", async () => {
    postChatMock.mockImplementation(async function* (_question: string, signal: AbortSignal) {
      yield { type: "token", delta: "Partial " } as const;
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.text).toBe("Partial "));

    act(() => {
      result.current.stop();
    });
    await act(async () => {
      await pending;
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "Partial ",
      stopped: true,
      error: null,
    });
    expect(result.current.banner).toBeNull();
    expect(result.current.streaming).toBe(false);
  });
});
