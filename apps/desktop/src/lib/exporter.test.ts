import { describe, expect, it } from "vitest";
import type { Conversation, StoredMessage } from "./db";
import { toJson, toMarkdown } from "./exporter";

const CONVERSATION: Conversation = {
  id: "conv-1",
  title: "Kündigungsfrist?",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
};

const USER_MESSAGE: StoredMessage = {
  id: "m1",
  conversationId: "conv-1",
  role: "user",
  content: "Wie lang ist die Kündigungsfrist?",
  sourcesJson: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SOURCE = {
  sr: "220",
  article: "335c",
  heading: "Kündigungsfrist",
  eli: "https://example.test/220",
  lang: "de",
  score: 6.9,
};

const ASSISTANT_MESSAGE: StoredMessage = {
  id: "m2",
  conversationId: "conv-1",
  role: "assistant",
  content: "Die Frist beträgt einen Monat [SR 220 Art. 335c].",
  sourcesJson: JSON.stringify([SOURCE]),
  createdAt: "2026-01-01T00:00:01.000Z",
};

const ASSISTANT_NO_SOURCES: StoredMessage = {
  id: "m3",
  conversationId: "conv-1",
  role: "assistant",
  content: "I don't know.",
  sourcesJson: null,
  createdAt: "2026-01-01T00:00:02.000Z",
};

// Pre-change data: a refusal answer stored before the zero-citations rule
// existed still carries the retrieved sources in sourcesJson, even though
// the answer text cites nothing.
const REFUSAL_WITH_STALE_SOURCES: StoredMessage = {
  id: "m5",
  conversationId: "conv-1",
  role: "assistant",
  content: "The current corpus contains no sources sufficient to answer this question.",
  sourcesJson: JSON.stringify([SOURCE]),
  createdAt: "2026-01-01T00:00:03.000Z",
};

describe("exporter.toJson", () => {
  it("serializes the conversation and messages as pretty-printed JSON", () => {
    const json = toJson(CONVERSATION, [USER_MESSAGE, ASSISTANT_MESSAGE]);
    expect(JSON.parse(json)).toEqual({
      conversation: CONVERSATION,
      messages: [USER_MESSAGE, ASSISTANT_MESSAGE],
    });
    expect(json).toContain("\n"); // pretty-printed, not minified
  });

  it("round-trips an empty message list", () => {
    expect(JSON.parse(toJson(CONVERSATION, []))).toEqual({
      conversation: CONVERSATION,
      messages: [],
    });
  });
});

describe("exporter.toMarkdown", () => {
  it("formats the title, speaker lines, and cited sources", () => {
    const md = toMarkdown(CONVERSATION, [USER_MESSAGE, ASSISTANT_MESSAGE]);
    expect(md).toBe(
      [
        "# Kündigungsfrist?",
        "",
        "**You:** Wie lang ist die Kündigungsfrist?",
        "",
        "**Assistant:** Die Frist beträgt einen Monat [SR 220 Art. 335c].",
        "",
        "- SR 220 Art. 335c",
        "",
      ].join("\n"),
    );
  });

  it("omits the source list when an assistant answer has none", () => {
    const md = toMarkdown(CONVERSATION, [ASSISTANT_NO_SOURCES]);
    expect(md).toBe(
      ["# Kündigungsfrist?", "", "**Assistant:** I don't know.", ""].join("\n"),
    );
    expect(md).not.toContain("- SR");
  });

  it("lists every source under its own answer, not just the first", () => {
    const second: StoredMessage = {
      ...ASSISTANT_MESSAGE,
      id: "m4",
      sourcesJson: JSON.stringify([SOURCE, { ...SOURCE, sr: "210", article: "1" }]),
    };
    const md = toMarkdown(CONVERSATION, [second]);
    expect(md).toContain("- SR 220 Art. 335c");
    expect(md).toContain("- SR 210 Art. 1");
  });

  it("handles an empty conversation", () => {
    expect(toMarkdown(CONVERSATION, [])).toBe("# Kündigungsfrist?\n");
  });

  it("omits stale sourcesJson on a stored refusal answer that cites nothing", () => {
    // Pre-change data: sourcesJson still holds the retrieved articles even
    // though the refusal text has no [SR ... Art. ...] citation. The export
    // must not leak them, mirroring useChat's loadConversation rule.
    const md = toMarkdown(CONVERSATION, [REFUSAL_WITH_STALE_SOURCES]);
    expect(md).not.toContain("- SR");
    expect(md).toBe(
      [
        "# Kündigungsfrist?",
        "",
        "**Assistant:** The current corpus contains no sources sufficient to answer this question.",
        "",
      ].join("\n"),
    );
  });
});
