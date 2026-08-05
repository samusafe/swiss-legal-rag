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
```

## Tests

Run from `apps/ingestion`:

```
cd apps/ingestion
pytest            # unit tests (offline; corpus integration auto-skips without data/raw)
pytest -m live    # opt-in smoke test against the real Fedlex endpoint
pytest -m corpus  # only the corpus integration test
```

Embedding is not implemented yet — see the roadmap in the root README.
