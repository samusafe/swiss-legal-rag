# retrieval

FastAPI service exposing hybrid search and RAG chat over the Swiss federal law corpus: dense retrieval (pgvector cosine similarity) and Postgres full-text search fused with Reciprocal Rank Fusion (RRF), re-ordered by a cross-encoder reranker, then handed to a local LLM for a cited answer streamed over SSE. The query-time service between the desktop app and the corpus — Postgres and Ollama are reached through it at query time.

## Prerequisites

1. Postgres with pgvector, running and embedded: `docker compose up -d` (from repo root), then `ingest embed` from `apps/ingestion` — see [`apps/ingestion/README.md`](../ingestion/README.md).
2. Ollama running with the embedding and chat models pulled: `ollama pull bge-m3`, `ollama pull qwen2.5:3b-instruct`, then `ollama serve` (or the desktop app).
3. Configuration from `.env` at the repo root (`cp .env.example .env` if you haven't) — `DATABASE_URL`, `OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, `RERANKER_MODEL`, `OLLAMA_CHAT_MODEL`, `INGESTION_PYTHON` (optional: path to ingestion venv, auto-derived from `apps/ingestion/.venv` when unset), plus the optional `RERANKER_REVISION`, `API_KEY`, and `RATE_LIMIT_PER_MINUTE` covered below.

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
single trusted user (the desktop app on the same machine). Authentication and rate limiting are
**opt-in and off by default** — with both unset, the API behaves exactly as an unauthenticated,
unthrottled local service. Do not expose it beyond `127.0.0.1`, and do not put it behind a
reverse proxy without adding your own auth layer first; the options below are a local safety net,
not a substitute for a real API gateway in a shared deployment.

| Setting | Env var | Default | Effect |
| --- | --- | --- | --- |
| API key | `API_KEY` | unset (no auth) | When set, every endpoint except `GET /health` and `GET /ready` requires a matching `X-API-Key` header, or the request gets `401 {"detail": "invalid or missing API key"}`. The desktop app's matching `VITE_API_KEY` build variable sends this header automatically (see `apps/desktop/README.md`). |
| Rate limit | `RATE_LIMIT_PER_MINUTE` | `0` (disabled) | When > 0, an in-memory token bucket per client IP throttles `POST /search`, `POST /chat`, and `POST /ingest` (GET status/progress/health/ready are never throttled). Over the limit returns `429 {"detail": "rate limit exceeded"}`. |

The rate limiter's state lives in this process's memory only — it does not coordinate across
multiple processes or workers. Run the API as a single `uvicorn` process (as shown above, with no
`--workers` flag); a multi-worker or multi-instance deployment needs a real gateway (e.g. an
nginx/Envoy layer or Redis-backed limiter) in front of it, not this in-memory bucket.

The limiter also keeps a small counter per client IP for the lifetime of the process, with no
eviction — harmless for a local single-user deployment (one or two IPs, ever), but unbounded if
the API is ever reachable from many unique IPs, where a fronting gateway is recommended instead.

The reranker (`RERANKER_MODEL`, `BAAI/bge-reranker-v2-m3` by default) downloads its weights from
Hugging Face on first use — a one-time network call the first time `/search` or `/chat` runs
against a fresh install; after that, everything is local and offline.

## Reproducibility

- **Dependencies** are exact-pinned in `pyproject.toml` (`==`), captured from a known-good
  `pip freeze`. Development tools (`pytest`, `ruff`, `mypy`) stay on `>=` ranges.
- **Reranker weights**: set `RERANKER_REVISION` to a Hugging Face commit hash or tag to pin the
  exact `RERANKER_MODEL` weights (passed to `CrossEncoder(..., revision=...)`). Unset (default)
  resolves to the model repo's current default revision, which can change over time — look up the
  commit hash on the model's Hugging Face "Files and versions" page and pin it there for a fully
  reproducible reranker.
- **Ollama models**: model *tags* (e.g. `qwen2.5:3b-instruct`, `bge-m3`) are not immutable —
  publishers can repoint a tag to new weights. For a byte-identical pin, resolve the tag to its
  content digest (`ollama show <tag> --modelfile` or the digest shown by `ollama list`) and pull
  by digest (`ollama pull <model>@sha256:<digest>`) instead of by tag when reproducibility across
  machines matters.

## API

### `GET /health`

```
curl -s http://localhost:8000/health
```

```json
{ "status": "ok" }
```

Static liveness probe — always `200` once the process is up.

### `GET /ready`

```
curl -s http://localhost:8000/ready
```

```json
{ "ready": true, "checks": { "postgres": true, "ollama": true, "corpus": true } }
```

Readiness probe: checks Postgres (`SELECT 1`), Ollama (`GET /api/tags` has both the configured chat and embedding models pulled), and the corpus (at least one embedded chunk). Returns `200` when every check passes, `503` with the same shape (and the failing checks set to `false`) otherwise. A failed check never raises — it just reports `false`.

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

### `POST /ingest`, `GET /ingest/status`, `GET /ingest/progress`, `POST /ingest/stop`

Runs the ingestion pipeline (`resolve → fetch → parse → embed`) as a background
subprocess of `apps/ingestion`'s venv, one run at a time.

- `GET /ingest/status` → `{"running", "phase", "acts", "chunks_total", "chunks_embedded"}` —
  counts come from `data/` and the `chunks` table (0 when Postgres is down, so the
  desktop panel renders before `docker compose up`).
- `POST /ingest` → `202 {"status": "started"}`, or `409` while a run is active.
- `GET /ingest/progress` → SSE (`progress` ~1/s with `{"phase", "done", "total"}`,
  then terminal `done` or `error`). Connecting while idle returns a snapshot and
  ends immediately.
- `POST /ingest/stop` → `200 {"status": "stopping"}`, or `409` when no run is active.
  Terminates the current phase's subprocess; the run then ends with an `error`
  event on `/ingest/progress` (progress already made in earlier phases is kept).

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
