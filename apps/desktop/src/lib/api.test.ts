import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "./api";
import { getHealth, postChat } from "./api";

vi.mock("./audit", () => ({
  logAudit: vi.fn(),
}));

import { logAudit } from "./audit";

const logAuditMock = vi.mocked(logAudit);

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
  logAuditMock.mockReset();
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

import { search } from "./api";

describe("search", () => {
  it("posts q/k/lang to /search and maps snake_case results to camelCase", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              sr: "220",
              article: "335c",
              heading: "Kündigung",
              context: "Die Kündigungsfrist…",
              text: "full text",
              eli: "https://example.test/e",
              act_name: "Obligationenrecht",
              score: 6.9,
            },
          ],
          took_ms: { embed: 1, search: 2, rerank: 3 },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const results = await search("Kündigungsfrist", 8, "de");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ q: "Kündigungsfrist", k: 8, lang: "de" }),
      }),
    );
    expect(results).toEqual([
      {
        sr: "220",
        article: "335c",
        heading: "Kündigung",
        context: "Die Kündigungsfrist…",
        text: "full text",
        eli: "https://example.test/e",
        actName: "Obligationenrecht",
        score: 6.9,
      },
    ]);
  });

  it("throws the backend detail on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "boom" }), { status: 422 })),
    );

    await expect(search("q", 8, "de")).rejects.toThrow("boom");
  });

  it("rejects with an ApiError and logs error.api on a 503 failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "database unavailable" }), { status: 503 }),
      ),
    );

    await expect(search("q", 5, "de")).rejects.toMatchObject({ status: 503 });
    expect(logAuditMock).toHaveBeenCalledWith("error.api", {
      endpoint: "/search",
      status: 503,
      message: expect.any(String),
      requestId: null,
    });
  });

  // I3: closes the X-Request-Id correlation loop — the header is captured
  // from the failing response and threaded into the error.api detail so it
  // can be matched against the backend's access-log line.
  it("captures the X-Request-Id response header into error.api's requestId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "database unavailable" }), {
          status: 503,
          headers: { "X-Request-Id": "b3f1a2c4-0000-4000-8000-000000000000" },
        }),
      ),
    );

    await expect(search("q", 5, "de")).rejects.toMatchObject({ status: 503 });
    expect(logAuditMock).toHaveBeenCalledWith(
      "error.api",
      expect.objectContaining({ requestId: "b3f1a2c4-0000-4000-8000-000000000000" }),
    );
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
import { getIngestStatus, postIngest, postIngestStop, streamIngestProgress } from "./api";

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

describe("postIngestStop", () => {
  it("POSTs to /ingest/stop and resolves on 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"status": "stopping"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await postIngestStop();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/ingest/stop",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws the 409 detail when no run is active", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"detail": "no ingest run is active"}', { status: 409 }),
      ),
    );
    await expect(postIngestStop()).rejects.toThrow("no ingest run is active");
  });
});

describe("X-API-Key header (VITE_API_KEY)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is omitted from every request when VITE_API_KEY is unset (default)", async () => {
    const api = await import("./api");
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"status": "ok"}'));
    vi.stubGlobal("fetch", fetchMock);

    await api.getHealth();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("X-API-Key");
  });

  it("is sent on postChat when VITE_API_KEY is set", async () => {
    vi.stubEnv("VITE_API_KEY", "secret-key");
    const api = await import("./api");
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(""));
    vi.stubGlobal("fetch", fetchMock);

    for await (const _event of api.postChat("q", new AbortController().signal)) {
      // drain the stream
    }

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/chat",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-API-Key": "secret-key" }),
      }),
    );
  });

  it("is sent on getHealth, getIngestStatus, postIngest, postIngestStop, and streamIngestProgress when set", async () => {
    vi.stubEnv("VITE_API_KEY", "secret-key");
    const api = await import("./api");
    // A fresh Response per call: bodies can only be read/streamed once.
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          '{"running": false, "phase": null, "acts": 0, "chunks_total": 0, "chunks_embedded": 0}',
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.getHealth();
    await api.getIngestStatus();
    await api.postIngest();
    await api.postIngestStop();
    for await (const _event of api.streamIngestProgress(new AbortController().signal)) {
      // drain
    }

    for (const call of fetchMock.mock.calls) {
      const [, init] = call as [string, RequestInit];
      expect(init.headers).toEqual(expect.objectContaining({ "X-API-Key": "secret-key" }));
    }
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
