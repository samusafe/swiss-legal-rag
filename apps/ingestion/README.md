# Ingestion

Python CLI that builds the local corpus: resolve Fedlex SPARQL metadata, fetch consolidated Akoma Ntoso XML, parse one article per chunk, embed through Ollama, and index into PostgreSQL/pgvector.

## Setup

```bash
cd apps/ingestion
python -m venv .venv
# Windows: .venv\Scripts\activate; Linux/macOS: source .venv/bin/activate
pip install -e ".[dev]"
```

## Pipeline

Run from the repository root:

```bash
ingest resolve    # corpus.yaml -> data/manifest.json
ingest fetch      # manifest -> data/raw/<sr>/<lang>.xml
ingest parse      # XML -> data/chunks/<sr>/<lang>.jsonl
ingest embed      # chunks -> PostgreSQL/pgvector
```

`resolve` asks the Fedlex SPARQL endpoint for current versions. `fetch` accepts only HTTPS URLs on `fedlex.data.admin.ch`, streams through a 50 MB limit, writes a temporary file, and atomically replaces the cache. `fetch-meta.json` records the URL and version date, so changed upstream versions are downloaded instead of being mistaken for an existing cache.

`embed` refreshes each act present in the current chunk directory transactionally. This removes revoked or renumbered articles, but recomputes embeddings for the complete act on every refresh — an interrupted rerun re-embeds the affected acts from scratch, not just the rows still missing vectors. Embedding the full corpus (~13k chunks) takes roughly 1-3 hours on a laptop CPU; avoid interrupting a run mid-way.

## Configuration

Copy the repository root `.env.example` to `.env`. The important values are `DATABASE_URL`, `OLLAMA_BASE_URL`, and `EMBEDDING_MODEL` (default `bge-m3`). Start PostgreSQL with `docker compose up -d` and Ollama with `ollama pull bge-m3` before `ingest embed`.

The downloaded corpus is machine-local under `data/` and is ignored by Git. Never commit credentials, private documents, or model/cache directories.

## Tests and checks

```bash
cd apps/ingestion
pytest
pytest -m live       # opt-in real Fedlex smoke test
pytest -m corpus     # local corpus integration test
pytest -m db         # database integration test; skips when unavailable
ruff check ingestion tests
mypy ingestion
```

The default suite is offline and excludes `live` tests. The parser uses secure XML parsing and should be treated as an untrusted-input boundary when adding new source formats.
