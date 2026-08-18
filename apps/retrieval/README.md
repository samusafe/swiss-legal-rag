# retrieval

FastAPI service exposing hybrid search and RAG chat over the Swiss federal and cantonal law corpus (federal law plus a St. Gallen and Bern pilot): dense retrieval (pgvector cosine similarity) and Postgres full-text search fused with Reciprocal Rank Fusion (RRF), re-ordered by a cross-encoder reranker, then handed to a local LLM for a cited answer streamed over SSE. The query-time service between the desktop app and the corpus — Postgres and Ollama are reached through it at query time.

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

## Access log

Every request (except `GET /health`, polled continuously by the desktop app) emits one JSON line
to stderr: `{"ts", "request_id", "method", "path", "status", "duration_ms"}`. `duration_ms`
measures time to the start of the response — the middleware wraps `call_next`, which returns as
soon as the response headers are ready, not once the body is fully sent. For the streaming
endpoints (`/chat`, `/ingest/progress`) the body streams *after* that point, so `duration_ms`
excludes generation time for `/chat` and excludes the run's actual duration for
`/ingest/progress` entirely. The same `request_id` is also returned as the `X-Request-Id`
response header (and exposed to cross-origin callers via `Access-Control-Expose-Headers`), so a
client-reported issue can be correlated with its server-side log line. Emission never fails the
request it describes — a logging error is swallowed rather than surfacing to the caller.

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
{ "q": "Wie viele Wochen Kündigungsfrist nach 6 Dienstjahren?", "lang": "de", "k": 5, "canton": null }
```

- `lang` — one of `de`, `fr`, `it` (the language used for full-text search; dense retrieval is cross-lingual).
- `k` — number of results to return (default 5, max 20).
- `canton` — optional two-letter canton code (e.g. `BE`, `SG`). Unset (default) searches the federal corpus only; a covered canton adds that canton's acts to the results alongside the federal corpus. An uncovered canton is still a valid code — it just currently returns no cantonal results (see `apps/desktop/README.md` for the federal-only badge shown in that case).

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
      "jurisdiction": "CH",
      "collection": "SR",
      "number": "220",
      "lang": "de",
      "article": "335c",
      "part": null,
      "eid": "art_335_c",
      "heading": "nach Ablauf der Probezeit",
      "context": "Beendigung des Arbeitsverhältnisses › Unbefristetes Arbeitsverhältnis › Kündigungsfristen › nach Ablauf der Probezeit",
      "text": "Art. 335c\n1 Das Arbeitsverhältnis kann im ersten Dienstjahr mit einer Kündigungsfrist von einem Monat, im zweiten bis und mit dem neunten Dienstjahr mit einer Frist von zwei Monaten…",
      "source_url": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335_c",
      "act_name": "Code of Obligations",
      "abbrev": "OR / CO",
      "version_date": "2026-01-01",
      "score": 0.87,
      "citation_label": "SR 220 Art. 335c"
    }
  ],
  "took_ms": { "embed": 12, "search": 8, "rerank": 340 }
}
```

`jurisdiction` is `CH` for federal acts or a canton code (e.g. `BE`, `SG`) for cantonal acts; `collection` is the source's systematic-collection code (`SR` for federal law, `BSG`/`sGS` for the Bern/St. Gallen pilots — see `corpus.yaml`). `citation_label` (`"<collection> <number> Art. <article>"`, e.g. `SR 220 Art. 335c` or `BSG 661.11 Art. 2`) is the exact bracketed form the model is expected to cite, and every result carries its official `source_url`, matching the citation contract used by `/chat`.

If Ollama is unreachable, `/search` returns `503` with an actionable message naming the endpoint it tried to reach.

### `GET /article`

Fetches one full article by citation key and language — used by the desktop app's article reader (opened from citation chips, source cards, and the search palette) to show the complete text behind a chunked search/chat result.

Query parameters:

- `jurisdiction` — `CH` for federal acts, or a canton code (e.g. `BE`, `SG`) for cantonal acts.
- `number` — the act's number within that jurisdiction's collection (e.g. `220` for SR 220, `661.11` for BSG 661.11).
- `article` — the article number (e.g. `335c`).
- `lang` — one of `de`, `fr`, `it`.

```
curl -s "http://localhost:8000/article?jurisdiction=CH&number=220&article=335c&lang=de"
```

Response (`ArticleResponse`):

```json
{
  "jurisdiction": "CH",
  "collection": "SR",
  "number": "220",
  "article": "335c",
  "lang": "de",
  "heading": "nach Ablauf der Probezeit",
  "act_name": "Code of Obligations",
  "abbrev": "OR / CO",
  "source_url": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335_c",
  "version_date": "2026-01-01",
  "texts": ["Art. 335c\n1 Das Arbeitsverhältnis kann..."],
  "available_langs": ["de", "fr", "it"],
  "citation_label": "SR 220 Art. 335c"
}
```

`texts` holds one string per stored paragraph/chunk of the article, in order, so the client can render the full article rather than a single retrieved chunk.

If the article doesn't exist in the requested `lang` but exists in another corpus language, the response is `404` naming the languages it is available in: `{"detail": "CH 220 Art. 335c not available in 'it' (available: de, fr)"}`. If it doesn't exist at all, `404 {"detail": "CH 220 Art. 335c not found"}`.

Subject to the same `X-API-Key` requirement as `/search` and `/chat` when `API_KEY` is set (see Security below); being a `GET`, it is never subject to `RATE_LIMIT_PER_MINUTE`, which only throttles `POST` endpoints.

### `POST /chat`

Runs `/search` internally to retrieve the top-`k` articles, then streams a generated answer over Server-Sent Events (SSE). Requires the chat model pulled in Ollama: `ollama pull qwen2.5:3b-instruct` (or set `OLLAMA_CHAT_MODEL` to a different local model).

Request:

```json
{ "question": "Welche Kündigungsfrist gilt im ersten Dienstjahr?", "lang": "de", "k": 5, "canton": null }
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
- `canton` — optional two-letter canton code (e.g. `BE`, `SG`), same semantics as `/search`: retrieval is federal-only unless a covered canton is set, in which case that canton's acts are included too.

```
curl -N -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"question": "Welche Kündigungsfrist gilt im ersten Dienstjahr?", "lang": "de"}'
```

The response is `text/event-stream` with up to five event types, in order:

| Event     | When                          | Payload                                                       |
| --------- | ------------------------------ | -------------------------------------------------------------- |
| `sources` | once, before generation starts | `{ "sources": [ { "jurisdiction", "collection", "number", "article", "heading", "source_url", "lang", "score", "citation_label" }, ... ] }` |
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
data: {"sources": [{"jurisdiction": "CH", "collection": "SR", "number": "220", "article": "335c", "heading": "nach Ablauf der Probezeit", "source_url": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335_c", "lang": "de", "score": 0.87, "citation_label": "SR 220 Art. 335c"}]}

event: thinking
data: {"delta": "The user is asking about the notice period in the first year..."}

event: token
data: {"delta": "Im ersten Dienstjahr gilt "}

event: token
data: {"delta": "eine Kündigungsfrist von einem Monat [SR 220 Art. 335c]."}

event: done
data: {"citations": [{"raw": "[SR 220 Art. 335c]", "label": "SR 220 Art. 335c", "collection": "SR", "number": "220", "article": "335c", "source_url": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335_c", "resolved": true}], "model": "qwen2.5:3b-instruct", "duration_ms": 4213}
```

Every answer cites its sources inline as `[<collection> <number> Art. <x>]` — `SR 220 Art. 335c` for a federal act, `BSG 661.11 Art. 2` for a Bernese cantonal act; the `done` event resolves each citation back to its retrieved source (`resolved: true`) or flags it as unresolved (`resolved: false`) if the model cited something outside the retrieved articles. If the retrieved articles don't answer the question, the model is instructed to say so and refuses to answer rather than cite anything.

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

## Performance

Everything runs on CPU, so the dominant cost of `/chat` is the language model
evaluating the prompt before the first token streams (minutes on a busy laptop,
not a failure). Three mitigations are built in:

- **Model keep-alive** — chat and embedding requests ask Ollama to keep the
  model resident for 30 minutes (`keep_alive`), so only the first question
  after a cold start pays the multi-GB weight load.
- **Search cache** — `/search` and the retrieval phase of `/chat` cache results
  in-process (LRU, keyed by question/k/lang/canton). A repeated question skips
  embedding and reranking entirely. The cache is cleared when an ingest run
  starts, since the corpus is about to change.
- **Generous first-token timeout** — the stream allows up to 10 minutes of
  silence before declaring a timeout, and a timeout is reported as a timeout
  ("still evaluating the prompt"), distinct from Ollama being unreachable.

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
