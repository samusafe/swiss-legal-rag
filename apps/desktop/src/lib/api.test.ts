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
  for await (const event of postChat(question, new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postChat", () => {
  it("yields sources, thinking, token and done events in order", async () => {
    const body =
      'event: sources\ndata: {"sources": [{"sr": "220", "article": "335c", "heading": "h", "eli": "https://example.test/e", "lang": "de", "score": 6.9}]}\n\n' +
      'event: thinking\ndata: {"delta": "checking Art. 335c… "}\n\n' +
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
      { type: "thinking", delta: "checking Art. 335c… " },
      { type: "token", delta: "Hallo" },
      { type: "done", citations: [], model: "qwen3:4b", durationMs: 12 },
    ]);
  });

  it("posts only the question to /chat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(""));
    vi.stubGlobal("fetch", fetchMock);

    await collect("Kündigungsfrist?");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ question: "Kündigungsfrist?" }),
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

import type { IngestEvent } from "./api";
import { getIngestStatus, postIngest, streamIngestProgress } from "./api";

async function collectIngest(): Promise<IngestEvent[]> {
  const events: IngestEvent[] = [];
  for await (const event of streamIngestProgress(new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

describe("getIngestStatus", () => {
  it("maps the snapshot to camelCase", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          '{"running": true, "phase": "embed", "acts": 10, "chunks_total": 12930, "chunks_embedded": 5420}',
        ),
      ),
    );
    expect(await getIngestStatus()).toEqual({
      running: true,
      phase: "embed",
      acts: 10,
      chunksTotal: 12930,
      chunksEmbedded: 5420,
    });
  });

  it("throws the backend detail on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"detail": "boom"}', { status: 500 })),
    );
    await expect(getIngestStatus()).rejects.toThrow("boom");
  });
});

describe("postIngest", () => {
  it("POSTs to /ingest and resolves on 202", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"status": "started"}', { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await postIngest();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/ingest",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws the 409 detail while a run is active", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"detail": "an ingest run is already active"}', { status: 409 }),
      ),
    );
    await expect(postIngest()).rejects.toThrow("an ingest run is already active");
  });
});

describe("streamIngestProgress", () => {
  it("yields progress and done events", async () => {
    const body =
      'event: progress\ndata: {"phase": "embed", "done": 5, "total": 10}\n\n' +
      'event: done\ndata: {"chunks_embedded": 10}\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(body)));
    expect(await collectIngest()).toEqual([
      { type: "progress", phase: "embed", done: 5, total: 10 },
      { type: "done", chunksEmbedded: 10 },
    ]);
  });

  it("maps the error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse('event: error\ndata: {"detail": "BOOM"}\n\n')),
    );
    expect(await collectIngest()).toEqual([{ type: "error", detail: "BOOM" }]);
  });

  it("throws on an unknown SSE event name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse("event: mystery\ndata: {}\n\n")),
    );
    await expect(collectIngest()).rejects.toThrow("unknown SSE event: mystery");
  });
});
