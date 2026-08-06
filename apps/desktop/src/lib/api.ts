import { createSseParser, type SseFrame } from "./sse";

export type Lang = "de" | "fr" | "it";

export interface Source {
  sr: string;
  article: string;
  heading: string | null;
  eli: string;
  lang: string;
  score: number;
}

export interface Citation {
  raw: string;
  sr: string;
  article: string;
  eli: string | null;
  resolved: boolean;
}

export type ChatEvent =
  | { type: "sources"; sources: Source[] }
  | { type: "token"; delta: string }
  | { type: "done"; citations: Citation[]; model: string; durationMs: number }
  | { type: "error"; detail: string };

export const API_BASE_URL: string =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export async function getHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "detail" in body &&
      typeof (body as { detail: unknown }).detail === "string"
    ) {
      return (body as { detail: string }).detail;
    }
  } catch {
    // non-JSON error body — fall through to the status line
  }
  return `HTTP ${response.status}`;
}

// Casts below are the backend boundary: payload shapes are owned and
// tested by apps/retrieval (see its /chat contract).
function toChatEvent(frame: SseFrame): ChatEvent {
  const data: unknown = JSON.parse(frame.data);
  switch (frame.event) {
    case "sources":
      return { type: "sources", sources: (data as { sources: Source[] }).sources };
    case "token":
      return { type: "token", delta: (data as { delta: string }).delta };
    case "done": {
      const done = data as { citations: Citation[]; model: string; duration_ms: number };
      return {
        type: "done",
        citations: done.citations,
        model: done.model,
        durationMs: done.duration_ms,
      };
    }
    case "error":
      return { type: "error", detail: (data as { detail: string }).detail };
    default:
      throw new Error(`unknown SSE event: ${frame.event}`);
  }
}

export async function* postChat(
  question: string,
  lang: Lang,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const response = await fetch(`${API_BASE_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, lang }),
    signal,
  });
  if (!response.ok) throw new Error(await errorDetail(response));
  if (response.body === null) throw new Error("chat response has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parse(decoder.decode(value, { stream: true }))) {
        yield toChatEvent(frame);
      }
    }
    for (const frame of parse(decoder.decode())) {
      yield toChatEvent(frame);
    }
  } finally {
    reader.releaseLock();
  }
}
