# retrieval

FastAPI service exposing hybrid search and RAG chat over the Swiss federal law corpus: dense retrieval (pgvector cosine similarity) and Postgres full-text search fused with Reciprocal Rank Fusion (RRF), re-ordered by a cross-encoder reranker, then handed to a local LLM for a cited answer streamed over SSE. The query-time service between the desktop app and the corpus — Postgres and Ollama are reached through it at query time.

## Prerequisites

1. Postgres with pgvector, running and embedded: `docker compose up -d` (from repo root), then `ingest embed` from `apps/ingestion` — see [`apps/ingestion/README.md`](../ingestion/README.md).
2. Ollama running with the embedding and chat models pulled: `ollama pull bge-m3`, `ollama pull qwen3:4b`, then `ollama serve` (or the desktop app).
3. Configuration from `.env` at the repo root (`cp .env.example .env` if you haven't) — `DATABASE_URL`, `OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, `RERANKER_MODEL`, `OLLAMA_CHAT_MODEL`.

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
.venv\Scripts\python.exe -m uvicorn retrieval.app:app --port 8000
```

Linux/macOS:

```
.venv/bin/python -m uvicorn retrieval.app:app --port 8000
```

The reranker model loads lazily on the first request to `/search` or `/chat`, so expect that first call to take ~30 s; subsequent calls are fast.

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

Runs `/search` internally to retrieve the top-`k` articles, then streams a generated answer over Server-Sent Events (SSE). Requires the chat model pulled in Ollama: `ollama pull qwen3:4b` (or set `OLLAMA_CHAT_MODEL` to a different local model).

Request:

```json
{ "question": "Welche Kündigungsfrist gilt im ersten Dienstjahr?", "lang": "de", "k": 5 }
```

- `lang` — one of `de`, `fr`, `it` (both the FTS query language and the language the answer is generated in).
- `k` — number of retrieved articles to ground the answer in (default 5, min 1, max 20).

```
curl -N -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{"question": "Welche Kündigungsfrist gilt im ersten Dienstjahr?", "lang": "de"}'
```

The response is `text/event-stream` with four event types, in order:

| Event    | When                          | Payload                                                       |
| -------- | ------------------------------ | -------------------------------------------------------------- |
| `sources`| once, before generation starts | `{ "sources": [ { "sr", "article", "heading", "eli", "lang", "score" }, ... ] }` |
| `token`  | once per generated token/delta | `{ "delta": "<text fragment>" }`                                |
| `done`   | once, on successful completion | `{ "citations": [...], "model": "qwen3:4b", "duration_ms": 4213 }` |
| `error`  | instead of `done`, if generation fails mid-stream | `{ "detail": "<message>" }`                  |

`duration_ms` covers generation only — retrieval (embed, search, rerank) runs before the stream starts and is not included.

Example stream (abridged):

```
event: sources
data: {"sources": [{"sr": "220", "article": "335c", "heading": "nach Ablauf der Probezeit", "eli": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335_c", "lang": "de", "score": 6.87}]}

event: token
data: {"delta": "Im ersten Dienstjahr gilt "}

event: token
data: {"delta": "eine Kündigungsfrist von einem Monat [SR 220 Art. 335c]."}

event: done
data: {"citations": [{"raw": "[SR 220 Art. 335c]", "sr": "220", "article": "335c", "eli": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335_c", "resolved": true}], "model": "qwen3:4b", "duration_ms": 4213}
```

Every answer cites its sources inline as `[SR <nr> Art. <x>]`; the `done` event resolves each citation back to its retrieved source (`resolved: true`) or flags it as unresolved (`resolved: false`) if the model cited something outside the retrieved articles. If the retrieved articles don't answer the question, the model is instructed to say so and refuses to answer rather than cite anything.

Retrieval failures (Ollama embeddings or Postgres unreachable) happen before any bytes stream and return a plain `503`, matching `/search`. Generation failures (Ollama chat unreachable or erroring mid-stream) happen after the response has already started streaming, so they surface as an `error` event instead.

## Tests

```
pytest              # unit tests — offline, no Postgres/Ollama required
pytest -m db         # database integration tests (auto-skip when Postgres is unreachable)
```
