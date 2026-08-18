import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import type { ChatEvent } from "../lib/api";
import { useChat } from "./useChat";

vi.mock("../lib/api", () => ({
  postChat: vi.fn(),
}));

// jsdom can't load the Tauri SQL IPC plugin that lib/db.ts imports, so — same
// as db.test.ts / useConversations.test.tsx — the module is mocked outright.
vi.mock("../lib/db", () => ({
  createConversation: vi.fn(),
  appendMessage: vi.fn(),
  getMessages: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: vi.fn(),
}));
vi.mock("../lib/audit", () => ({
  logAudit: vi.fn(),
}));

import { postChat } from "../lib/api";
import { appendMessage, createConversation, getMessages } from "../lib/db";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { logAudit } from "../lib/audit";

const postChatMock = vi.mocked(postChat);
const createConversationMock = vi.mocked(createConversation);
const appendMessageMock = vi.mocked(appendMessage);
const getMessagesMock = vi.mocked(getMessages);
const sendNotificationMock = vi.mocked(sendNotification);
const logAuditMock = vi.mocked(logAudit);

/** document.hidden is a read-only getter in jsdom — override it per test. */
function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

async function* events(list: ChatEvent[]): AsyncGenerator<ChatEvent> {
  for (const event of list) yield event;
}

const SOURCE = {
  jurisdiction: "ch",
  collection: "SR",
  number: "220",
  article: "335c",
  heading: "h",
  sourceUrl: "https://example.test/e",
  lang: "de",
  score: 6.9,
  citationLabel: "SR 220 Art. 335c",
};
const CITATION = {
  raw: "[SR 220 Art. 335c]",
  label: "SR 220 Art. 335c",
  collection: "SR",
  number: "220",
  article: "335c",
  sourceUrl: "https://example.test/e",
  resolved: true,
};

const CONVERSATION = {
  id: "conv-1",
  title: "New chat",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("useChat", () => {
  beforeEach(() => {
    postChatMock.mockReset();
    createConversationMock.mockReset();
    appendMessageMock.mockReset();
    getMessagesMock.mockReset();
    logAuditMock.mockReset();
    createConversationMock.mockResolvedValue(CONVERSATION);
    appendMessageMock.mockResolvedValue("msg-1");
  });

  it("builds the transcript from sources, token and done events", async () => {
    postChatMock.mockReturnValue(
      events([
        { type: "sources", sources: [SOURCE] },
        { type: "token", delta: "Die Frist " },
        { type: "token", delta: "beträgt einen Monat [SR 220 Art. 335c]." },
        { type: "done", citations: [CITATION], model: "m", durationMs: 1, refusal: false },
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

  test("done with zero citations but no refusal keeps the sources visible", async () => {
    // Regression: a small model that writes citations in a malformed format
    // ("Artikel 7 BSG 661.11" instead of "[BSG 661.11 Art. 7]") yields zero
    // extracted citations — that is NOT a refusal, and hiding the articles
    // the answer was grounded in makes the defect impossible to inspect.
    postChatMock.mockReturnValue(
      events([
        { type: "sources", sources: [SOURCE] },
        { type: "token", delta: "Laut Artikel 7 BSG 661.11 gilt..." },
        { type: "done", citations: [], model: "m", durationMs: 1, refusal: false },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.sources).toEqual([SOURCE]);
    expect(result.current.messages.at(-1)?.sources).toEqual([SOURCE]);
  });

  test("done with zero citations clears sources", async () => {
    postChatMock.mockReturnValue(
      events([
        { type: "sources", sources: [SOURCE, { ...SOURCE, article: "1" }] },
        { type: "token", delta: "No applicable provision found." },
        { type: "done", citations: [], model: "m", durationMs: 1, refusal: true },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.sources).toEqual([]);
    expect(result.current.messages.at(-1)?.sources).toEqual([]);
    expect(appendMessageMock).toHaveBeenNthCalledWith(2, {
      conversationId: "conv-1",
      role: "assistant",
      content: "No applicable provision found.",
      sourcesJson: "[]",
    });
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

  it("persists no assistant row when an in-band error arrives before any token", async () => {
    // Sources came, generation failed, nothing streamed: an empty assistant
    // row would reload later as a bogus "interrupted" note (the error the
    // user actually saw is not persisted).
    postChatMock.mockReturnValue(
      events([
        { type: "sources", sources: [SOURCE] },
        { type: "error", detail: "Ollama timed out" },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "",
      error: "Ollama timed out",
    });
    expect(appendMessageMock).toHaveBeenCalledTimes(1); // the user message only
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

  // Was "stop() does not persist the unfinished assistant turn" — that
  // asserted the exact bug the review flagged (I6): a stopped stream kept its
  // partial answer on screen but never wrote it to storage, so resuming the
  // conversation showed a saved question with no reply. Updated to assert
  // the fixed behavior: the partial answer is persisted too.
  it("stop() persists the partial assistant turn, so a resumed conversation is not left with a dangling question", async () => {
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
    act(() => result.current.stop());
    await act(async () => {
      await pending;
    });

    expect(appendMessageMock).toHaveBeenCalledTimes(2); // user message + partial assistant turn
    expect(appendMessageMock).toHaveBeenNthCalledWith(2, {
      conversationId: "conv-1",
      role: "assistant",
      content: "Partial ",
      sourcesJson: JSON.stringify([]),
    });
  });

  // N1 regression: persistPartialAnswer() used to be awaited unwrapped
  // inside this catch branch, so a rejecting appendMessage() rejected
  // send() itself — and App's `void send(...).then(...)` call site had no
  // rejection handler, turning a silent save failure into an unhandled
  // promise rejection too. `await pending` below would itself throw if
  // send() still rejected, so this test fails loudly on a regression.
  it("stop(): a failed save of the partial answer surfaces as a banner, and send() does not reject", async () => {
    postChatMock.mockImplementation(async function* (_question: string, signal: AbortSignal) {
      yield { type: "token", delta: "Partial " } as const;
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    appendMessageMock.mockResolvedValueOnce("msg-user"); // user message
    appendMessageMock.mockRejectedValueOnce(new Error("disk full")); // partial assistant save
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.text).toBe("Partial "));
    act(() => result.current.stop());
    await act(async () => {
      await pending; // throws here (test fails) if send() still rejects
    });

    expect(result.current.banner).toBe("disk full");
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "Partial ",
      stopped: true,
    });
  });

  it("stop() before any token streams persists nothing beyond the user message (no empty assistant row)", async () => {
    postChatMock.mockImplementation(async function* (_question: string, signal: AbortSignal) {
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));
    act(() => result.current.stop());
    await act(async () => {
      await pending;
    });

    expect(appendMessageMock).toHaveBeenCalledTimes(1); // the user message only
    expect(appendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant" }),
    );
  });

  it("persists the partial assistant turn when the stream throws mid-answer (not a user stop)", async () => {
    postChatMock.mockImplementation(async function* () {
      yield { type: "token", delta: "Partial" } as const;
      throw new Error("connection reset");
    });
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.banner).toBe("connection reset");
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "Partial",
      error: "connection reset",
    });
    expect(appendMessageMock).toHaveBeenCalledTimes(2); // user message + partial assistant turn
    expect(appendMessageMock).toHaveBeenNthCalledWith(2, {
      conversationId: "conv-1",
      role: "assistant",
      content: "Partial",
      sourcesJson: JSON.stringify([]),
    });
  });

  // N1 regression, mid-stream-error variant of the stop-path test above:
  // a rejecting appendMessage() on this path must also surface visibly
  // (not just the original stream error) and must not reject send().
  it("mid-stream throw: a failed save of the partial answer also surfaces as a banner, and send() does not reject", async () => {
    postChatMock.mockImplementation(async function* () {
      yield { type: "token", delta: "Partial" } as const;
      throw new Error("connection reset");
    });
    appendMessageMock.mockResolvedValueOnce("msg-user"); // user message
    appendMessageMock.mockRejectedValueOnce(new Error("disk full")); // partial assistant save
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q"); // throws here (test fails) if send() still rejects
    });

    expect(result.current.banner).toBe("disk full");
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "Partial",
      error: "connection reset",
    });
  });

  // N1's second wart: a failing clean-completion persist used to fall into
  // this same catch block, which retried the identical write a second
  // time. With the fix, the retry is a guarded no-op — only 2 appendMessage
  // calls (user + the one failed attempt), never 3.
  it("does not retry a failed clean-completion save from the catch block", async () => {
    postChatMock.mockReturnValue(events([{ type: "token", delta: "Ein Monat" }]));
    appendMessageMock.mockResolvedValueOnce("msg-user"); // user message
    appendMessageMock.mockRejectedValueOnce(new Error("disk full")); // clean-completion save
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(appendMessageMock).toHaveBeenCalledTimes(2); // no retried third call
    expect(result.current.banner).toBe("disk full");
  });

  it("logs chat.question and a done chat.answer with duration", async () => {
    postChatMock.mockReturnValue(
      events([
        { type: "sources", sources: [SOURCE] },
        { type: "token", delta: "Die Frist " },
        { type: "token", delta: "beträgt einen Monat [SR 220 Art. 335c]." },
        { type: "done", citations: [CITATION], model: "m", durationMs: 1, refusal: false },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("Kündigungsfrist?");
    });

    expect(logAuditMock).toHaveBeenCalledWith("chat.question", {
      conversationId: expect.any(String),
      messageId: expect.any(String),
    });
    expect(logAuditMock).toHaveBeenCalledWith(
      "chat.answer",
      expect.objectContaining({ model: "m", outcome: "done", refusal: false, citations: 1 }),
      expect.any(Number),
    );
  });

  it("logs a refusal chat.answer when done carries no citations", async () => {
    postChatMock.mockReturnValue(
      events([
        { type: "sources", sources: [SOURCE, { ...SOURCE, article: "1" }] },
        { type: "token", delta: "No applicable provision found." },
        { type: "done", citations: [], model: "m", durationMs: 1, refusal: true },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(logAuditMock).toHaveBeenCalledWith(
      "chat.answer",
      expect.objectContaining({ model: "m", outcome: "done", refusal: true, citations: 0 }),
      expect.any(Number),
    );
  });

  // I1 regression: `model` comes from the SSE `done` event only — a turn
  // that never reaches `done` (stopped by the user) must log `model: null`
  // rather than an empty answer being mistaken for a known model.
  it("logs chat.answer with model: null when stopped before the done event arrives", async () => {
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
    act(() => result.current.stop());
    await act(async () => {
      await pending;
    });

    expect(logAuditMock).toHaveBeenCalledWith(
      "chat.answer",
      expect.objectContaining({ model: null, outcome: "stopped" }),
      expect.any(Number),
    );
  });
});

describe("useChat persistence", () => {
  beforeEach(() => {
    postChatMock.mockReset();
    createConversationMock.mockReset();
    appendMessageMock.mockReset();
    getMessagesMock.mockReset();
    logAuditMock.mockReset();
    createConversationMock.mockResolvedValue(CONVERSATION);
    appendMessageMock.mockResolvedValue("msg-1");
  });

  it("creates a conversation on the first message, titled from the question", async () => {
    postChatMock.mockReturnValue(events([{ type: "token", delta: "Ein Monat" }]));
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("Kündigungsfrist?");
    });

    expect(createConversationMock).toHaveBeenCalledExactlyOnceWith("Kündigungsfrist?");
    expect(result.current.conversationId).toBe("conv-1");
  });

  it("calls onConversationCreated with the new row's id as soon as it's persisted, before the stream finishes", async () => {
    let releaseToken: (() => void) | undefined;
    postChatMock.mockImplementation(async function* () {
      yield { type: "token", delta: "Partial " } as const;
      await new Promise<void>((resolve) => {
        releaseToken = resolve;
      });
    });
    const onConversationCreated = vi.fn();
    const { result } = renderHook(() => useChat(onConversationCreated));

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("Kündigungsfrist?");
    });

    await waitFor(() => expect(onConversationCreated).toHaveBeenCalledExactlyOnceWith("conv-1"));
    // The stream is still hanging — the sidebar must not have to wait for it.
    expect(result.current.streaming).toBe(true);

    act(() => releaseToken?.());
    await act(async () => {
      await pending;
    });
  });

  it("truncates a long first question to 60 chars for the conversation title", async () => {
    postChatMock.mockReturnValue(events([]));
    const { result } = renderHook(() => useChat());
    const longQuestion = "a".repeat(80);

    await act(async () => {
      await result.current.send(longQuestion);
    });

    expect(createConversationMock).toHaveBeenCalledExactlyOnceWith("a".repeat(60));
  });

  it("persists the user message immediately and the assistant message once, with its sources", async () => {
    postChatMock.mockReturnValue(
      events([
        { type: "sources", sources: [SOURCE] },
        { type: "token", delta: "Ein " },
        { type: "token", delta: "Monat" },
        { type: "done", citations: [CITATION], model: "m", durationMs: 1, refusal: false },
      ]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("Kündigungsfrist?");
    });

    expect(appendMessageMock).toHaveBeenCalledTimes(2);
    expect(appendMessageMock).toHaveBeenNthCalledWith(1, {
      conversationId: "conv-1",
      role: "user",
      content: "Kündigungsfrist?",
      sourcesJson: null,
    });
    expect(appendMessageMock).toHaveBeenNthCalledWith(2, {
      conversationId: "conv-1",
      role: "assistant",
      content: "Ein Monat",
      sourcesJson: JSON.stringify([SOURCE]),
    });
  });

  it("reuses the same conversation for a follow-up message instead of creating a second one", async () => {
    postChatMock.mockReturnValue(events([{ type: "token", delta: "x" }]));
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("one");
    });
    await act(async () => {
      await result.current.send("two");
    });

    expect(createConversationMock).toHaveBeenCalledOnce();
    expect(appendMessageMock).toHaveBeenCalledTimes(4); // user+assistant per turn
    for (const call of appendMessageMock.mock.calls) {
      expect(call[0].conversationId).toBe("conv-1");
    }
  });

  it("does not persist anything when the request fails before any tokens stream", async () => {
    postChatMock.mockImplementation(async function* () {
      throw new Error("database unavailable at localhost:5432");
    });
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(appendMessageMock).toHaveBeenCalledExactlyOnceWith({
      conversationId: "conv-1",
      role: "user",
      content: "q",
      sourcesJson: null,
    });
    expect(result.current.banner).toBe("database unavailable at localhost:5432");
  });

  it("reset() clears chat state and creates no conversation row", async () => {
    postChatMock.mockReturnValue(events([{ type: "token", delta: "x" }]));
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.send("one");
    });
    expect(result.current.conversationId).toBe("conv-1");
    createConversationMock.mockClear();

    act(() => result.current.reset());

    expect(result.current.messages).toEqual([]);
    expect(result.current.sources).toEqual([]);
    expect(result.current.thinking).toBe("");
    expect(result.current.banner).toBeNull();
    expect(result.current.conversationId).toBeNull();
    expect(createConversationMock).not.toHaveBeenCalled();

    // A message after reset() starts a brand-new conversation.
    await act(async () => {
      await result.current.send("two");
    });
    expect(createConversationMock).toHaveBeenCalledExactlyOnceWith("two");
  });

  it("loadConversation() rebuilds messages, sources and citations, and sets conversationId", async () => {
    getMessagesMock.mockResolvedValue([
      {
        id: "m1",
        conversationId: "conv-9",
        role: "user",
        content: "Kündigungsfrist?",
        sourcesJson: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "m2",
        conversationId: "conv-9",
        role: "assistant",
        content: "Ein Monat [SR 220 Art. 335c], siehe auch [SR 210 Art. 1].",
        sourcesJson: JSON.stringify([SOURCE]),
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.loadConversation("conv-9");
    });

    expect(getMessagesMock).toHaveBeenCalledExactlyOnceWith("conv-9");
    expect(result.current.conversationId).toBe("conv-9");
    expect(result.current.sources).toEqual([SOURCE]);
    expect(result.current.messages).toEqual([
      { role: "user", text: "Kündigungsfrist?", citations: [], error: null, sources: undefined },
      {
        role: "assistant",
        text: "Ein Monat [SR 220 Art. 335c], siehe auch [SR 210 Art. 1].",
        citations: [
          CITATION,
          {
            raw: "[SR 210 Art. 1]",
            label: "SR 210 Art. 1",
            collection: "SR",
            number: "210",
            article: "1",
            sourceUrl: null,
            resolved: false,
          },
        ],
        error: null,
        sources: [SOURCE],
      },
    ]);
  });

  // Bug regression: an app kill mid-generation leaves the user question
  // persisted but no completed assistant reply — if a *blank* assistant row
  // exists (whitespace-only content), reopening the conversation must mark
  // it `stopped` so MessageList renders the interrupted-turn note instead of
  // a bare empty bubble. A normal, non-empty answer is untouched.
  it("loadConversation() marks an empty/whitespace-only assistant row as stopped (interrupted turn)", async () => {
    getMessagesMock.mockResolvedValue([
      {
        id: "m1",
        conversationId: "conv-9",
        role: "user",
        content: "Kündigungsfrist?",
        sourcesJson: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "m2",
        conversationId: "conv-9",
        role: "assistant",
        content: "   ",
        sourcesJson: null,
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.loadConversation("conv-9");
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "   ",
      stopped: true,
    });
  });

  it("loadConversation() leaves a normal (non-empty) assistant answer unmarked", async () => {
    getMessagesMock.mockResolvedValue([
      {
        id: "m1",
        conversationId: "conv-9",
        role: "assistant",
        content: "Ein Monat.",
        sourcesJson: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.loadConversation("conv-9");
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "Ein Monat.",
    });
    expect(result.current.messages.at(-1)?.stopped).toBeUndefined();
  });

  it("loadConversation() sets the banner and leaves state untouched when the read fails", async () => {
    getMessagesMock.mockRejectedValue(new Error("disk full"));
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.loadConversation("conv-9");
    });

    expect(result.current.banner).toBe("disk full");
    expect(result.current.conversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
  });

  it("a follow-up message after resuming appends to the resumed conversation", async () => {
    getMessagesMock.mockResolvedValue([]);
    postChatMock.mockReturnValue(events([{ type: "token", delta: "x" }]));
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.loadConversation("conv-9");
    });
    await act(async () => {
      await result.current.send("more");
    });

    expect(createConversationMock).not.toHaveBeenCalled();
    expect(appendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-9", role: "user" }),
    );
  });

  // --- Background generation -------------------------------------------
  // Switching conversations mid-stream must no longer abort the in-flight
  // generation: it keeps running for its own conversation, the sidebar can
  // be told which conversation that is, and navigating back re-attaches to
  // its live, still-growing transcript instead of losing it.

  it("(a) switching to another conversation does not abort the in-flight generation — it keeps running and persists normally", async () => {
    let releaseSecondToken: (() => void) | undefined;
    postChatMock.mockImplementation(async function* (_question: string, _signal: AbortSignal) {
      yield { type: "token", delta: "Partial " } as const;
      await new Promise<void>((resolve) => {
        releaseSecondToken = resolve;
      });
      yield { type: "token", delta: "done." } as const;
    });
    getMessagesMock.mockResolvedValue([]); // the conversation switched to
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.text).toBe("Partial "));

    await act(async () => {
      await result.current.loadConversation("conv-9");
    });
    // Viewing a different, empty conversation — nothing streamed there, and
    // switching away did not abort anything.
    expect(result.current.conversationId).toBe("conv-9");
    expect(result.current.messages).toEqual([]);
    expect(result.current.streaming).toBe(false);

    act(() => releaseSecondToken?.());
    await act(async () => {
      await pending;
    });

    // The background turn ran to completion (not "stopped") and persisted.
    expect(logAuditMock).toHaveBeenCalledWith(
      "chat.answer",
      expect.objectContaining({ outcome: "done" }),
      expect.any(Number),
    );
    expect(appendMessageMock).toHaveBeenCalledWith({
      conversationId: "conv-1",
      role: "assistant",
      content: "Partial done.",
      sourcesJson: "[]",
    });
  });

  it("(b) re-attaches to the live partial when navigating back to the generating conversation, without hitting the DB", async () => {
    let releaseToken: (() => void) | undefined;
    postChatMock.mockImplementation(async function* () {
      yield { type: "token", delta: "Partial " } as const;
      await new Promise<void>((resolve) => {
        releaseToken = resolve;
      });
    });
    getMessagesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.text).toBe("Partial "));

    await act(async () => {
      await result.current.loadConversation("conv-9");
    });
    expect(result.current.messages).toEqual([]);
    getMessagesMock.mockClear();

    await act(async () => {
      await result.current.loadConversation("conv-1");
    });

    expect(result.current.conversationId).toBe("conv-1");
    expect(result.current.streaming).toBe(true);
    expect(result.current.messages.at(-1)?.text).toBe("Partial ");
    expect(getMessagesMock).not.toHaveBeenCalled(); // re-attach uses the live turn, not a DB fetch

    act(() => releaseToken?.());
    await act(async () => {
      await pending;
    });
  });

  it("(c) exposes generatingId for the streaming conversation, independent of what's visible, clearing once it finishes", async () => {
    let releaseToken: (() => void) | undefined;
    postChatMock.mockImplementation(async function* () {
      yield { type: "token", delta: "Partial " } as const;
      await new Promise<void>((resolve) => {
        releaseToken = resolve;
      });
    });
    getMessagesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() => expect(result.current.generatingId).toBe("conv-1"));

    await act(async () => {
      await result.current.loadConversation("conv-9");
    });
    expect(result.current.generatingId).toBe("conv-1"); // unaffected by navigation
    expect(result.current.conversationId).toBe("conv-9");

    act(() => releaseToken?.());
    await act(async () => {
      await pending;
    });

    expect(result.current.generatingId).toBeNull();
  });

  it("(d) stop() still works and persists the partial as stopped after navigating back to the generating conversation", async () => {
    postChatMock.mockImplementation(async function* (_question: string, signal: AbortSignal) {
      yield { type: "token", delta: "Partial " } as const;
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    getMessagesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.text).toBe("Partial "));

    await act(async () => {
      await result.current.loadConversation("conv-9");
    });
    await act(async () => {
      await result.current.loadConversation("conv-1");
    });
    expect(result.current.streaming).toBe(true);

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
    });
    expect(appendMessageMock).toHaveBeenCalledWith({
      conversationId: "conv-1",
      role: "assistant",
      content: "Partial ",
      sourcesJson: "[]",
    });
  });

  it("(e) notifyDeleted() on the generating conversation aborts its stream and blocks the partial answer from persisting into the deleted row", async () => {
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
    await waitFor(() => expect(result.current.generatingId).toBe("conv-1"));

    act(() => result.current.notifyDeleted("conv-1"));
    await act(async () => {
      await pending;
    });

    expect(result.current.generatingId).toBeNull();
    // The open+generating conversation was deleted: the view resets too.
    expect(result.current.conversationId).toBeNull();
    expect(result.current.messages).toEqual([]);
    // Only the user message was persisted before the delete — the partial
    // answer must not be written into the now-deleted conversation row.
    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(appendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant" }),
    );
  });

  it("(f) exposes generatingId for an existing conversation from the moment send() starts, before the stream has emitted anything (the pre-first-token 'Searching articles' phase) — survives reset() to a blank chat, and re-entering still shows the in-progress turn", async () => {
    // Simulates a slow retrieval/rerank phase: the stream hangs with zero
    // events (not even `sources`) until released.
    let releaseStream: (() => void) | undefined;
    postChatMock.mockImplementation(async function* () {
      await new Promise<void>((resolve) => {
        releaseStream = resolve;
      });
    });
    // "test" is an existing conversation, already open (not created by this
    // send()) — mirrors the real repro: the owner reopened it after an app
    // restart, then sent a new message into it.
    getMessagesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useChat());
    await act(async () => {
      await result.current.loadConversation("conv-1");
    });
    expect(result.current.conversationId).toBe("conv-1");

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });

    // A turn is "generating" from the instant send() starts, not from the
    // first token — createConversation() is never called (existing
    // conversation), so this must be true synchronously, with no stream
    // event and no waitFor needed.
    expect(result.current.generatingId).toBe("conv-1");
    expect(createConversationMock).not.toHaveBeenCalled();

    act(() => {
      result.current.reset();
    });
    expect(result.current.conversationId).toBeNull();
    // The contract under test: reset() only navigates the *view* — it must
    // never clear a still-running background generation.
    expect(result.current.generatingId).toBe("conv-1");

    await act(async () => {
      await result.current.loadConversation("conv-1");
    });
    expect(result.current.streaming).toBe(true);
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "",
    });

    act(() => releaseStream?.());
    await act(async () => {
      await pending;
    });
    expect(result.current.generatingId).toBeNull();
  });
});

describe("useChat unread outcomes (sidebar notification dots)", () => {
  beforeEach(() => {
    postChatMock.mockReset();
    createConversationMock.mockReset();
    appendMessageMock.mockReset();
    getMessagesMock.mockReset();
    logAuditMock.mockReset();
    createConversationMock.mockResolvedValue(CONVERSATION);
    appendMessageMock.mockResolvedValue("msg-1");
  });

  it("(a) records a 'done' entry when the turn completes while the user is viewing a different conversation", async () => {
    let releaseToken: (() => void) | undefined;
    postChatMock.mockImplementation(async function* () {
      yield { type: "token", delta: "Ein Monat" } as const;
      await new Promise<void>((resolve) => {
        releaseToken = resolve;
      });
    });
    getMessagesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() => expect(result.current.conversationId).toBe("conv-1"));

    await act(async () => {
      await result.current.loadConversation("conv-9");
    });
    expect(result.current.conversationId).toBe("conv-9");

    act(() => releaseToken?.());
    await act(async () => {
      await pending;
    });

    expect(result.current.unreadOutcomes).toEqual({ "conv-1": "done" });
  });

  it("(b) records no entry when the turn completes while the user is still viewing it", async () => {
    postChatMock.mockReturnValue(events([{ type: "token", delta: "Ein Monat" }]));
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(result.current.unreadOutcomes).toEqual({});
  });

  it("(c) records an 'error' entry when the stream throws mid-answer while the user is elsewhere", async () => {
    let throwError: (() => void) | undefined;
    postChatMock.mockImplementation(async function* () {
      yield { type: "token", delta: "Partial" } as const;
      await new Promise<void>((resolve) => {
        throwError = resolve;
      });
      throw new Error("connection reset");
    });
    getMessagesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() => expect(result.current.conversationId).toBe("conv-1"));

    await act(async () => {
      await result.current.loadConversation("conv-9");
    });

    act(() => throwError?.());
    await act(async () => {
      await pending;
    });

    expect(result.current.unreadOutcomes).toEqual({ "conv-1": "error" });
  });

  it("(d) loadConversation() clears the unread entry for the conversation being opened", async () => {
    let releaseToken: (() => void) | undefined;
    postChatMock.mockImplementation(async function* () {
      yield { type: "token", delta: "Ein Monat" } as const;
      await new Promise<void>((resolve) => {
        releaseToken = resolve;
      });
    });
    getMessagesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() => expect(result.current.conversationId).toBe("conv-1"));
    await act(async () => {
      await result.current.loadConversation("conv-9");
    });
    act(() => releaseToken?.());
    await act(async () => {
      await pending;
    });
    expect(result.current.unreadOutcomes).toEqual({ "conv-1": "done" });

    await act(async () => {
      await result.current.loadConversation("conv-1");
    });

    expect(result.current.unreadOutcomes).toEqual({});
  });

  it("(e) a user-initiated stop() records no unread entry, even when the user has navigated elsewhere", async () => {
    postChatMock.mockImplementation(async function* (_question: string, signal: AbortSignal) {
      yield { type: "token", delta: "Partial " } as const;
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    getMessagesMock.mockResolvedValue([]);
    const { result } = renderHook(() => useChat());

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.send("q");
    });
    await waitFor(() => expect(result.current.conversationId).toBe("conv-1"));
    await act(async () => {
      await result.current.loadConversation("conv-9");
    });

    act(() => result.current.stop());
    await act(async () => {
      await pending;
    });

    expect(result.current.unreadOutcomes).toEqual({});
  });
});

describe("useChat completion notification", () => {
  beforeEach(() => {
    postChatMock.mockReset();
    createConversationMock.mockReset();
    appendMessageMock.mockReset();
    getMessagesMock.mockReset();
    sendNotificationMock.mockReset();
    logAuditMock.mockReset();
    createConversationMock.mockResolvedValue(CONVERSATION);
    appendMessageMock.mockResolvedValue("msg-1");
    localStorage.clear();
  });

  afterEach(() => {
    setDocumentHidden(false);
  });

  it("notifies with the first line of the answer when the window is hidden (pref on by default)", async () => {
    setDocumentHidden(true);
    postChatMock.mockReturnValue(
      events([{ type: "token", delta: "Ein Monat.\nSee [SR 220 Art. 335c]." }]),
    );
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    await waitFor(() => expect(sendNotificationMock).toHaveBeenCalledOnce());
    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "Swiss Legal RAG",
      body: "Ein Monat.",
    });
  });

  it("does not notify while the window is visible", async () => {
    setDocumentHidden(false);
    postChatMock.mockReturnValue(events([{ type: "token", delta: "Ein Monat" }]));
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("does not notify when the notify preference is off, even if hidden", async () => {
    localStorage.setItem("slr.notify", "false");
    setDocumentHidden(true);
    postChatMock.mockReturnValue(events([{ type: "token", delta: "Ein Monat" }]));
    const { result } = renderHook(() => useChat());

    await act(async () => {
      await result.current.send("q");
    });

    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("does not notify when the answer was stopped mid-stream", async () => {
    setDocumentHidden(true);
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
    act(() => result.current.stop());
    await act(async () => {
      await pending;
    });

    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("does not notify when the stream ends with an in-band error event, but still persists as today", async () => {
    setDocumentHidden(true);
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

    expect(sendNotificationMock).not.toHaveBeenCalled();
    // Persistence behavior is unchanged by the notification gate: the
    // completed (errored) turn is still persisted exactly as before.
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "Partial",
      error: "ollama down",
    });
    expect(appendMessageMock).toHaveBeenCalledTimes(2); // user + assistant, same as any clean turn
    expect(appendMessageMock).toHaveBeenNthCalledWith(2, {
      conversationId: "conv-1",
      role: "assistant",
      content: "Partial",
      sourcesJson: JSON.stringify([]),
    });
  });
});
