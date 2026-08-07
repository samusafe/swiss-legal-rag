# retrieval

FastAPI service exposing hybrid search and RAG chat over the Swiss federal law corpus: dense retrieval (pgvector cosine similarity) and Postgres full-text search fused with Reciprocal Rank Fusion (RRF), re-ordered by a cross-encoder reranker, then handed to a local LLM for a cited answer streamed over SSE. The query-time service between the desktop app and the corpus — Postgres and Ollama are reached through it at query time.

## Prerequisites

1. Postgres with pgvector, running and embedded: `docker compose up -d` (from repo root), then `ingest embed` from `apps/ingestion` — see [`apps/ingestion/README.md`](../ingestion/README.md).
2. Ollama running with the embedding and chat models pulled: `ollama pull bge-m3`, `ollama pull qwen2.5:3b-instruct`, then `ollama serve` (or the desktop app).
3. Configuration from `.env` at the repo root (`cp .env.example .env` if you haven't) — `DATABASE_URL`, `OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, `RERANKER_MODEL`, `OLLAMA_CHAT_MODEL`, `INGESTION_PYTHON` (optional: path to ingestion venv, auto-derived from `apps/ingestion/.venv` when unset).

## Setup

```
cd apps/retrieval
python -m venv .venv
# Windows: .venv\Scripts\activate    Linux: source .venv/bin/activate
pip install -e ".[dev]"
```

The reranker (`sentence-transformers` + `torch`) is a ~2 GB download on first install — CPU-only wheels, no GPU required.

## Run

Windows:

```
.venv\Scripts\python.exe -m uvicorn retrieval.app:app --host 127.0.0.1 --port 8000
```

Linux/macOS:

```
.venv/bin/python -m uvicorn retrieval.app:app --host 127.0.0.1 --port 8000
```

`--host 127.0.0.1` binds the API to localhost only — the service is unauthenticated by
design (see Security below), so it must never listen on a network-reachable interface.

The reranker model loads lazily on the first request to `/search` or `/chat`, so expect that first call to take ~30 s; subsequent calls are fast.

## Security

This service is designed to run entirely on localhost, alongside Postgres and Ollama, for a
single trusted user (the desktop app on the same machine). It has **no authentication or
authorization** — anyone who can reach the port can query it and trigger ingestion. Do not
expose it beyond `127.0.0.1`, and do not put it behind a reverse proxy without adding your own
auth layer first.

The reranker (`RERANKER_MODEL`, `BAAI/bge-reranker-v2-m3` by default) downloads its weights from
Hugging Face on first use — a one-time network call the first time `/search` or `/chat` runs
against a fresh install; after that, everything is local and offline.

## API

### `GET /health`

```
curl -s http://localhost:8000/health
```

```json
{ "status": "ok" }
```

### `POST /search`

Request:

```json
{ "q": "Wie viele Wochen Kündigungsfrist nach 6 Dienstjahren?", "lang": "de", "k": 5 }
```

- `lang` — one of `de`, `fr`, `it` (the language used for full-text search; dense retrieval is cross-lingual).
- `k` — number of results to return (default 5, max 20).

```
curl -s http://localhost:8000/search \
  -H "Content-Type: application/json" \
  -d '{"q": "Wie viele Wochen Kündigungsfrist nach 6 Dienstjahren?", "lang": "de"}'
```

Response:

```json
{
  "results": [
    {
      "sr": "220",
      "lang": "de",
      "article": "335c",
      "part": null,
      "eid": "art_335_c",
      "heading": "nach Ablauf der Probezeit",
      "context": "Beendigung des Arbeitsverhältnisses › Unbefristetes Arbeitsverhältnis › Kündigungsfristen › nach Ablauf der Probezeit",
      "text": "Art. 335c\n1 Das Arbeitsverhältnis kann im ersten Dienstjahr mit einer Kündigungsfrist von einem Monat, im zweiten bis und mit dem neunten Dienstjahr mit einer Frist von zwei Monaten…",
      "eli": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335_c",
      "act_name": "Code of Obligations",
      "abbrev": "OR / CO",
      "version_date": "2026-01-01",
      "score": 6.87
    }
  ],
  "took_ms": { "embed": 12, "search": 8, "rerank": 340 }
}
```

Every result carries its official ELI link and SR/article citation (`[SR 220 Art. 335c]`), matching the citation contract used by `/chat`.

If Ollama is unreachable, `/search` returns `503` with an actionable message naming the endpoint it tried to reach.

### `POST /chat`

Runs `/search` internally to retrieve the top-`k` articles, then streams a generated answer over Server-Sent Events (SSE). Requires the chat model pulled in Ollama: `ollama pull qwen2.5:3b-instruct` (or set `OLLAMA_CHAT_MODEL` to a different local model).

Request:

```json
{ "question": "Welche Kündigungsfrist gilt im ersten Dienstjahr?", "lang": "de", "k": 5 }
```

- `lang` — optional, one of `de`, `fr`, `it` (both the FTS query language and the language the
  answer is generated in). Omit it (or pass `null`) to let the server detect the question's
  language automatically:
  - The answer is generated in the detected language (any language `langdetect` recognizes with
    ≥70% confidence), falling back to English if detection is inconclusive.
  - Full-text search uses the detected language only when it's `de`, `fr`, or `it` — for any other
    detected (or undetected) language, `/chat` retrieves with dense search + rerank only (no FTS
    arm), since there's no FTS configuration to query with.
- `k` — number of retrieved articles to ground the answer in (default 5, min 1, max 20).

```
curl -N -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"question": "Welche Kündigungsfrist gilt im ersten Dienstjahr?", "lang": "de"}'
```

The response is `text/event-stream` with up to five event types, in order:

| Event     | When                          | Payload                                                       |
| --------- | ------------------------------ | -------------------------------------------------------------- |
| `sources` | once, before generation starts | `{ "sources": [ { "sr", "article", "heading", "eli", "lang", "score" }, ... ] }` |
| `thinking`| zero or more, before the answer, if the model reasons before answering | `{ "delta": "<reasoning fragment>" }` |
| `token`   | once per generated answer token/delta | `{ "delta": "<text fragment>" }` — may be empty: heartbeats keep the stream cancellable while the model's reasoning is still ambiguous |
| `done`    | once, on successful completion | `{ "citations": [...], "model": "qwen2.5:3b-instruct", "duration_ms": 4213 }` |
| `error`   | instead of `done`, if generation fails mid-stream | `{ "detail": "<message>" }`                  |

`thinking` events carry the model's reasoning (for hybrid-reasoning models that emit a
`<think>…</think>` block) so a client can show it separately from the final answer; clients that
don't care about it can simply ignore events they don't recognize.

`duration_ms` covers generation only — retrieval (embed, search, rerank) runs before the stream starts and is not included.

Example stream (abridged):

```
event: sources
data: {"sources": [{"sr": "220", "article": "335c", "heading": "nach Ablauf der Probezeit", "eli": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335_c", "lang": "de", "score": 6.87}]}

event: thinking
data: {"delta": "The user is asking about the notice period in the first year..."}

event: token
data: {"delta": "Im ersten Dienstjahr gilt "}

event: token
data: {"delta": "eine Kündigungsfrist von einem Monat [SR 220 Art. 335c]."}

event: done
data: {"citations": [{"raw": "[SR 220 Art. 335c]", "sr": "220", "article": "335c", "eli": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335_c", "resolved": true}], "model": "qwen2.5:3b-instruct", "duration_ms": 4213}
```

Every answer cites its sources inline as `[SR <nr> Art. <x>]`; the `done` event resolves each citation back to its retrieved source (`resolved: true`) or flags it as unresolved (`resolved: false`) if the model cited something outside the retrieved articles. If the retrieved articles don't answer the question, the model is instructed to say so and refuses to answer rather than cite anything.

Retrieval failures (Ollama embeddings or Postgres unreachable) happen before any bytes stream and return a plain `503`, matching `/search`. Generation failures (Ollama chat unreachable or erroring mid-stream) happen after the response has already started streaming, so they surface as an `error` event instead.

Hybrid-reasoning chat models' `<think>…</think>` reasoning is separated server-side from the
answer and forwarded as `thinking` events (never mixed into citation extraction, which only sees
`token` deltas); a stream that never emits a `</think>` marker is delivered as a single `token`
flush at the end.

### `POST /ingest`, `GET /ingest/status`, `GET /ingest/progress`

Runs the ingestion pipeline (`resolve → fetch → parse → embed`) as a background
subprocess of `apps/ingestion`'s venv, one run at a time.

- `GET /ingest/status` → `{"running", "phase", "acts", "chunks_total", "chunks_embedded"}` —
  counts come from `data/` and the `chunks` table (0 when Postgres is down, so the
  desktop panel renders before `docker compose up`).
- `POST /ingest` → `202 {"status": "started"}`, or `409` while a run is active.
- `GET /ingest/progress` → SSE (`progress` ~1/s with `{"phase", "done", "total"}`,
  then terminal `done` or `error`). Connecting while idle returns a snapshot and
  ends immediately.

Set `INGESTION_PYTHON` in `.env` if the ingestion venv lives outside the default
`apps/ingestion/.venv` layout.

## Tests

```
pytest              # unit tests — offline, no Postgres/Ollama required
pytest -m db         # database integration tests (auto-skip when Postgres is unreachable)
ruff check retrieval tests
mypy retrieval
```

The API is intentionally a localhost-only, trusted-user service. `/ingest` starts a local
subprocess and is not suitable for an internet-facing deployment without authentication,
authorization, rate limiting, request limits, and a hardened process boundary.
