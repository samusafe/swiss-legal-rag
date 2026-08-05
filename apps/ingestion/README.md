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
```

## Tests

Run from `apps/ingestion`:

```
cd apps/ingestion
pytest            # unit tests (offline, mocked HTTP)
pytest -m live    # opt-in smoke test against the real Fedlex endpoint
```

Parsing and embedding are not implemented yet — see the roadmap in the root README.
