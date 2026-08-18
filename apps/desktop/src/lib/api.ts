import { createSseParser, type SseFrame } from "./sse";
import { logAudit } from "./audit";
import { getJurisdiction } from "./jurisdiction";

export interface Source {
  jurisdiction: string;
  collection: string;
  number: string;
  article: string;
  heading: string | null;
  sourceUrl: string;
  lang: string;
  score: number;
  citationLabel: string;
}

export interface Citation {
  raw: string;
  label: string;
  collection: string;
  number: string;
  article: string;
  sourceUrl: string | null;
  resolved: boolean;
}

// Backend boundary shapes (snake_case, over the wire) for the SSE payloads
// mapped below — kept next to their camelCase counterparts above.
interface WireSource {
  jurisdiction: string;
  collection: string;
  number: string;
  article: string;
  heading: string | null;
  source_url: string;
  lang: string;
  score: number;
  citation_label: string;
}

interface WireCitation {
  raw: string;
  label: string;
  collection: string;
  number: string;
  article: string;
  source_url: string | null;
  resolved: boolean;
}

function fromWireSource(source: WireSource): Source {
  return {
    jurisdiction: source.jurisdiction,
    collection: source.collection,
    number: source.number,
    article: source.article,
    heading: source.heading,
    sourceUrl: source.source_url,
    lang: source.lang,
    score: source.score,
    citationLabel: source.citation_label,
  };
}

function fromWireCitation(citation: WireCitation): Citation {
  return {
    raw: citation.raw,
    label: citation.label,
    collection: citation.collection,
    number: citation.number,
    article: citation.article,
    sourceUrl: citation.source_url,
    resolved: citation.resolved,
  };
}

export type ChatEvent =
  | { type: "sources"; sources: Source[] }
  | { type: "thinking"; delta: string }
  | { type: "token"; delta: string }
  | { type: "done"; citations: Citation[]; model: string; durationMs: number; refusal: boolean }
  | { type: "error"; detail: string };

export const API_BASE_URL: string =
  // 127.0.0.1, not localhost: uvicorn binds IPv4-only and localhost can
  // resolve to ::1 in the webview, which reads as "offline" while the API is up.
  import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";

// Debug feature, off by default: raw model reasoning is unpredictable and not
// meant for end users. Set VITE_SHOW_THINKING=true at build time to enable the
// expandable reasoning disclosure in MessageList.
export const SHOW_THINKING: boolean = import.meta.env.VITE_SHOW_THINKING === "true";

// Empty by default, matching the retrieval API's own opt-in API_KEY (unset = no
// auth). Set VITE_API_KEY at build time when the retrieval API requires it.
export const API_KEY: string = import.meta.env.VITE_API_KEY ?? "";

function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  return API_KEY === "" ? base : { ...base, "X-API-Key": API_KEY };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function getHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE_URL}/health`, { headers: authHeaders() });
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

async function failResponse(endpoint: string, response: Response): Promise<never> {
  const detail = await errorDetail(response);
  // The API client is the single choke point for error.api events — the
  // matching backend line is correlated via X-Request-Id in its own log.
  // null when the header is missing (e.g. a request that never reached the
  // backend's access_log middleware, such as a network failure or /health).
  const requestId = response.headers.get("X-Request-Id");
  logAudit("error.api", { endpoint, status: response.status, message: detail, requestId });
  throw new ApiError(detail, response.status);
}

async function* sseEvents<T>(
  response: Response,
  toEvent: (frame: SseFrame) => T,
): AsyncGenerator<T> {
  if (response.body === null) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parse(decoder.decode(value, { stream: true }))) {
        yield toEvent(frame);
      }
    }
    for (const frame of parse(decoder.decode())) {
      yield toEvent(frame);
    }
  } finally {
    reader.releaseLock();
  }
}

// Casts below are the backend boundary: payload shapes are owned and
// tested by apps/retrieval (see its /chat contract).
function toChatEvent(frame: SseFrame): ChatEvent {
  const data: unknown = JSON.parse(frame.data);
  switch (frame.event) {
    case "sources": {
      const sources = (data as { sources: WireSource[] }).sources;
      return { type: "sources", sources: sources.map(fromWireSource) };
    }
    case "thinking":
      return { type: "thinking", delta: (data as { delta: string }).delta };
    case "token":
      return { type: "token", delta: (data as { delta: string }).delta };
    case "done": {
      const done = data as {
        citations: WireCitation[];
        model: string;
        duration_ms: number;
        refusal?: boolean;
      };
      return {
        type: "done",
        citations: done.citations.map(fromWireCitation),
        model: done.model,
        durationMs: done.duration_ms,
        // Tolerate an older backend that predates the field: absent means
        // "not a refusal", never "hide the sources".
        refusal: done.refusal ?? false,
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
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const response = await fetch(`${API_BASE_URL}/chat`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ question, canton: getJurisdiction().canton }),
    signal,
  });
  if (!response.ok) await failResponse("/chat", response);
  yield* sseEvents(response, toChatEvent);
}

// The retrieval /search endpoint requires a concrete corpus language (its FTS
// index is per-language); "en" is a UI-only language, so callers map it down
// to one of these before calling search().
export type SearchLang = "de" | "fr" | "it";

export interface SearchResult {
  jurisdiction: string;
  collection: string;
  number: string;
  article: string;
  heading: string | null;
  context: string | null;
  text: string;
  sourceUrl: string;
  actName: string;
  score: number;
  citationLabel: string;
}

export async function search(
  q: string,
  k: number,
  lang: SearchLang,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const response = await fetch(`${API_BASE_URL}/search`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ q, k, lang, canton: getJurisdiction().canton }),
    signal,
  });
  if (!response.ok) await failResponse("/search", response);
  // Backend boundary cast: payload shape owned and tested by apps/retrieval.
  const data = (await response.json()) as {
    results: Array<{
      jurisdiction: string;
      collection: string;
      number: string;
      article: string;
      heading: string | null;
      context: string | null;
      text: string;
      source_url: string;
      act_name: string;
      score: number;
      citation_label: string;
    }>;
  };
  return data.results.map((r) => ({
    jurisdiction: r.jurisdiction,
    collection: r.collection,
    number: r.number,
    article: r.article,
    heading: r.heading,
    context: r.context,
    text: r.text,
    sourceUrl: r.source_url,
    actName: r.act_name,
    score: r.score,
    citationLabel: r.citation_label,
  }));
}

export interface Article {
  jurisdiction: string;
  collection: string;
  number: string;
  article: string;
  lang: string;
  heading: string | null;
  actName: string;
  abbrev: string;
  sourceUrl: string;
  versionDate: string;
  texts: string[];
  availableLangs: string[];
  citationLabel: string;
}

export async function fetchArticle(
  jurisdiction: string,
  number: string,
  article: string,
  lang: SearchLang,
  signal?: AbortSignal,
): Promise<Article> {
  const params = new URLSearchParams({ jurisdiction, number, article, lang });
  const response = await fetch(`${API_BASE_URL}/article?${params.toString()}`, {
    headers: authHeaders(),
    signal,
  });
  if (!response.ok) await failResponse("/article", response);
  // Backend boundary cast: payload shape owned and tested by apps/retrieval.
  const data = (await response.json()) as {
    jurisdiction: string;
    collection: string;
    number: string;
    article: string;
    lang: string;
    heading: string | null;
    act_name: string;
    abbrev: string;
    source_url: string;
    version_date: string;
    texts: string[];
    available_langs: string[];
    citation_label: string;
  };
  return {
    jurisdiction: data.jurisdiction,
    collection: data.collection,
    number: data.number,
    article: data.article,
    lang: data.lang,
    heading: data.heading,
    actName: data.act_name,
    abbrev: data.abbrev,
    sourceUrl: data.source_url,
    versionDate: data.version_date,
    texts: data.texts,
    availableLangs: data.available_langs,
    citationLabel: data.citation_label,
  };
}

export interface IngestStatus {
  running: boolean;
  phase: string | null;
  acts: number;
  chunksTotal: number;
  chunksEmbedded: number;
}

export type IngestEvent =
  | { type: "progress"; phase: string; done: number; total: number }
  | { type: "done"; chunksEmbedded: number }
  | { type: "error"; detail: string };

export async function getIngestStatus(): Promise<IngestStatus> {
  const response = await fetch(`${API_BASE_URL}/ingest/status`, { headers: authHeaders() });
  if (!response.ok) await failResponse("/ingest/status", response);
  // Backend boundary cast: payload shape owned and tested by apps/retrieval.
  const data = (await response.json()) as {
    running: boolean;
    phase: string | null;
    acts: number;
    chunks_total: number;
    chunks_embedded: number;
  };
  return {
    running: data.running,
    phase: data.phase,
    acts: data.acts,
    chunksTotal: data.chunks_total,
    chunksEmbedded: data.chunks_embedded,
  };
}

export async function postIngest(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/ingest`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!response.ok) await failResponse("/ingest", response);
}

export async function postIngestStop(): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/ingest/stop`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!response.ok) await failResponse("/ingest/stop", response);
}

// Backend boundary casts, same contract note as toChatEvent.
function toIngestEvent(frame: SseFrame): IngestEvent {
  const data: unknown = JSON.parse(frame.data);
  switch (frame.event) {
    case "progress": {
      const progress = data as { phase: string; done: number; total: number };
      return {
        type: "progress",
        phase: progress.phase,
        done: progress.done,
        total: progress.total,
      };
    }
    case "done":
      return {
        type: "done",
        chunksEmbedded: (data as { chunks_embedded: number }).chunks_embedded,
      };
    case "error":
      return { type: "error", detail: (data as { detail: string }).detail };
    default:
      throw new Error(`unknown SSE event: ${frame.event}`);
  }
}

export async function* streamIngestProgress(
  signal: AbortSignal,
): AsyncGenerator<IngestEvent> {
  const response = await fetch(`${API_BASE_URL}/ingest/progress`, {
    signal,
    headers: authHeaders(),
  });
  if (!response.ok) await failResponse("/ingest/progress", response);
  yield* sseEvents(response, toIngestEvent);
}
