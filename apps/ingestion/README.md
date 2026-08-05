# ingestion

Python CLI that builds the corpus: resolve Fedlex SPARQL → fetch Akoma Ntoso XML → parse articles (1 article = 1 chunk) → embed via Ollama → index into pgvector.

## Setup

```
cd apps/ingestion
python -m venv .venv
# Windows: .venv\Scripts\activate    Linux: source .venv/bin/activate
pip install -e ".[dev]"
```

## Usage (from repo root)

```
ingest resolve    # corpus.yaml -> data/manifest.json (current versions via SPARQL)
ingest fetch      # manifest -> data/raw/<sr>/<lang>.xml (cached, ~1 req/s)
ingest parse      # manifest + raw XML -> data/chunks/<sr>/<lang>.jsonl (1 line = 1 article chunk)
ingest embed      # chunks JSONL -> Postgres/pgvector (schema applied automatically)
```

### Embedding

`ingest embed` needs two services running:

1. Postgres with pgvector: `docker compose up -d` (from repo root).
2. Ollama with the embedding model pulled: `ollama pull bge-m3`, then make sure `ollama serve` (or the desktop app) is running.

Configuration comes from `.env` at the repo root (`cp .env.example .env` if you haven't) — `DATABASE_URL`, `OLLAMA_BASE_URL`, `EMBEDDING_MODEL`.

The command is **resumable**: chunks whose text is unchanged and already embedded are skipped, so you can interrupt it (Ctrl+C) and rerun at any time — including finishing a run started on another machine, as long as it points at the same database. Progress is committed per batch.

Expect roughly **1–3 hours on a laptop CPU** for the full corpus (~13k chunks); a machine with a GPU-accelerated Ollama does the same in ~15 minutes. A rerun over an already-embedded corpus takes seconds.

## Tests

Run from `apps/ingestion`:

```
cd apps/ingestion
pytest            # unit tests (offline; corpus integration auto-skips without data/raw)
pytest -m live    # opt-in smoke test against the real Fedlex endpoint
pytest -m corpus  # only the corpus integration test
pytest -m db      # database integration test (auto-skips when Postgres is unreachable)
```
