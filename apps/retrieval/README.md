# retrieval

FastAPI service exposing hybrid search over the Swiss federal law corpus: dense retrieval (pgvector cosine similarity) and Postgres full-text search fused with Reciprocal Rank Fusion (RRF), then re-ordered by a cross-encoder reranker for final relevance. The query-time service between the desktop app and the corpus — Postgres and Ollama are reached through it at query time.

`/chat` (RAG with citation contract, SSE streaming) lands in a later milestone.

## Prerequisites

1. Postgres with pgvector, running and embedded: `docker compose up -d` (from repo root), then `ingest embed` from `apps/ingestion` — see [`apps/ingestion/README.md`](../ingestion/README.md).
2. Ollama running with the embedding model pulled: `ollama pull bge-m3`, then `ollama serve` (or the desktop app).
3. Configuration from `.env` at the repo root (`cp .env.example .env` if you haven't) — `DATABASE_URL`, `OLLAMA_BASE_URL`, `EMBEDDING_MODEL`, `RERANKER_MODEL`.

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

The reranker model loads lazily on the first request to `/search`, so expect that first call to take ~30 s; subsequent calls are fast.

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

## Tests

```
pytest              # unit tests — offline, no Postgres/Ollama required
pytest -m db         # database integration tests (auto-skip when Postgres is unreachable)
```
