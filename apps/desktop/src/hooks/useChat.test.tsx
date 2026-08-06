import { act, renderHook } from "@testing-library/react";
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
      },
    ]);
    expect(result.current.sources).toEqual([SOURCE]);
    expect(result.current.streaming).toBe(false);
    expect(result.current.banner).toBeNull();
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

  it("passes the selected lang to postChat", async () => {
    postChatMock.mockReturnValue(events([]));
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.setLang("fr");
    });
    await act(async () => {
      await result.current.send("q");
    });

    expect(postChatMock).toHaveBeenCalledWith("q", "fr", expect.any(AbortSignal));
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
});
