# Ingestion

Python CLI that builds the local corpus from `corpus.yaml`: resolve each jurisdiction's source metadata, fetch the source documents, parse one article per chunk, embed through Ollama, and index into PostgreSQL/pgvector. Two source types are supported, one act's `source` field per jurisdiction block in `corpus.yaml`:

- **`fedlex`** (federal law): resolve queries the Fedlex SPARQL endpoint for the current consolidated version, `fetch` downloads the Akoma Ntoso XML.
- **`lexwork`** (cantonal law pilot — SG, BE): resolve calls each canton's LexWork (Sitrox) JSON API directly and caches the response; there is no separate fetch step for these acts (see below).

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
ingest fetch      # manifest -> data/raw/<jurisdiction>/<number>/<lang>.xml (fedlex only)
ingest parse      # data/raw -> data/chunks/<jurisdiction>/<number>/<lang>.jsonl
ingest embed      # chunks -> PostgreSQL/pgvector
```

`resolve` asks the Fedlex SPARQL endpoint for current versions of `fedlex` acts. For `lexwork` acts it instead calls `{base_url}/api/{lang}/texts_of_law/{number}` directly (`base_url` is the canton's own LexWork instance, set per jurisdiction in `corpus.yaml`) and caches the raw JSON response at `data/raw/<jurisdiction>/<number>.<lang>.json` — both source types are rate-limited to ~1 request/second.

`fetch` only downloads `fedlex` acts: it accepts exclusively HTTPS URLs on `fedlex.data.admin.ch`, streams through a 50 MB limit, writes a temporary file, and atomically replaces the cache. `fetch-meta.json` records the URL and version date, so changed upstream versions are downloaded instead of being mistaken for an existing cache. `lexwork` acts have nothing to do at this step — their JSON was already downloaded and cached during `resolve` — `fetch` just confirms the cached file is present and fails loud if it isn't (run `ingest resolve` again).

`data/raw/` layout: `<jurisdiction>/<number>/<lang>.xml` for federal (Fedlex) acts, `<jurisdiction>/<number>.<lang>.json` for cantonal (LexWork) acts — `<jurisdiction>` is `CH` or a canton code (e.g. `SG`, `BE`), matching the `code` field of each `corpus.yaml` jurisdiction block.

`embed` incrementally refreshes each act present in the current chunk directory, transactionally, keyed by content hash (compared as raw text). Unchanged articles keep their existing embeddings and are left untouched; new or changed articles are written with `embedding = NULL` and picked up by the embedding phase; revoked or renumbered articles are deleted. Because only rows with `embedding IS NULL` get re-embedded, an interrupted rerun resumes where it left off instead of starting the affected acts from scratch. Embedding a full initial corpus (~13k chunks) still takes roughly 1-3 hours on a laptop CPU; subsequent runs only pay that cost for what actually changed.

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
