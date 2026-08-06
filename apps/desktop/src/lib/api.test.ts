import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "./api";
import { getHealth, postChat } from "./api";

function sseResponse(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function collect(question = "q"): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of postChat(question, "de", new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postChat", () => {
  it("yields sources, token and done events in order", async () => {
    const body =
      'event: sources\ndata: {"sources": [{"sr": "220", "article": "335c", "heading": "h", "eli": "https://example.test/e", "lang": "de", "score": 6.9}]}\n\n' +
      'event: token\ndata: {"delta": "Hallo"}\n\n' +
      'event: done\ndata: {"citations": [], "model": "qwen3:4b", "duration_ms": 12}\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(body)));

    expect(await collect()).toEqual([
      {
        type: "sources",
        sources: [
          { sr: "220", article: "335c", heading: "h", eli: "https://example.test/e", lang: "de", score: 6.9 },
        ],
      },
      { type: "token", delta: "Hallo" },
      { type: "done", citations: [], model: "qwen3:4b", durationMs: 12 },
    ]);
  });

  it("posts question and lang (no k) to /chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(""));
    vi.stubGlobal("fetch", fetchMock);

    await collect("Kündigungsfrist?");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ question: "Kündigungsfrist?", lang: "de" }),
      }),
    );
  });

  it("throws the backend detail on a 503 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "database unavailable at localhost:5432" }), {
          status: 503,
        }),
      ),
    );

    await expect(collect()).rejects.toThrow("database unavailable at localhost:5432");
  });

  it("falls back to the HTTP status when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    );

    await expect(collect()).rejects.toThrow("HTTP 500");
  });

  it("maps a mid-stream error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse('event: error\ndata: {"detail": "ollama down"}\n\n')),
    );

    expect(await collect()).toEqual([{ type: "error", detail: "ollama down" }]);
  });

  it("throws on an unknown SSE event name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse("event: mystery\ndata: {}\n\n")),
    );

    await expect(collect()).rejects.toThrow("unknown SSE event: mystery");
  });
});

describe("getHealth", () => {
  it("returns true when /health responds ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"status": "ok"}')));
    expect(await getHealth()).toBe(true);
  });

  it("returns false when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(await getHealth()).toBe(false);
  });

  it("returns false on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    expect(await getHealth()).toBe(false);
  });
});
