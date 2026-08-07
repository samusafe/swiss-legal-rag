# Swiss Legal RAG

Swiss federal-law question answering with local retrieval-augmented generation. Ask a question in German, French, Italian, or another language recognized by the detector; the system retrieves official Fedlex articles and streams back an answer with article-level citations. Everything runs locally — no API keys, no cloud services, no data leaving your machine.

> **Not legal advice — research/educational; always verify the official source.**

## Features

- **Cross-lingual retrieval.** Ask in French, retrieve the governing German article, get the answer back in the question's language — every claim cited as `[SR 220 Art. 335c]` and linked to the official Fedlex ELI page.
- **Hybrid search + rerank.** pgvector cosine search and PostgreSQL full-text search fused with reciprocal-rank fusion, then reordered by a cross-encoder reranker.
- **Grounded answers only.** The chat model only sees retrieved source blocks; if retrieval returns no sources, the API refuses deterministically instead of guessing.
- **Streamed responses.** `/chat` streams `sources`, optional `thinking`, `token`, `done`, and `error` server-sent events to the desktop client.
- **Desktop app with live ingestion.** The Tauri client can also trigger and monitor the ingestion pipeline (resolve → fetch → parse → embed) with live progress.
- **Evaluation harness.** A gold Q&A dataset per language plus deterministic retrieval/citation/refusal metrics, runnable locally and loggable to MLflow.

## Architecture

```text
apps/
├── desktop/      Tauri 2 + React chat UI — SSE streaming, citation chips to Fedlex, auto-detected
│                 answer language, and an ingestion trigger with live progress
├── retrieval/    FastAPI — hybrid search (pgvector + Postgres FTS, RRF) → cross-encoder rerank →
│                 RAG with SSE
├── ingestion/    Python CLI — Fedlex SPARQL → Akoma Ntoso XML → 1 article = 1 chunk → embed → index
└── evals/        Gold Q&A dataset (DE/FR/IT) + LLM-assisted drafting CLI + retrieval/citation/
                  refusal scoring
db/init/          PostgreSQL + pgvector bootstrap SQL
corpus.yaml       The corpus manifest: ~10 federal acts × 3 languages
```

- **Data:** official Fedlex open data (SPARQL + consolidated-law XML) — no scraping, reuse expressly authorized.
- **Models:** BGE-M3 embeddings + a local chat model via [Ollama](https://ollama.com), BGE cross-encoder reranker on CPU.
- **Storage:** PostgreSQL 16 + pgvector (Docker), hybrid dense + full-text search fused with RRF.
- **Evaluation:** gold Q&A dataset per language, retrieval/citation/refusal metrics — the scorecard gates every change.

## Scope and limitations

- **Federal law only.** Switzerland has three legislative levels — federal, cantonal (26 cantons, each with its own collection), and communal. This project covers the federal level (Fedlex). Cantonal questions are refused by design rather than answered without sources; refusal accuracy is part of the eval suite. Cantonal law has no uniform structured API comparable to Fedlex SPARQL/Akoma Ntoso, so supporting it would be a per-canton effort.
- **DE/FR/IT corpus.** The indexed corpus and full-text search cover German, French, and Italian, matching Switzerland's three federal languages. Dense retrieval is cross-lingual, so questions in other languages are answered by detecting the question's language and falling back to English when detection is inconclusive; citations always point to the official DE/FR/IT texts, which alone are legally binding.
- **Answers may be outdated or incorrect.** Generated text is produced by a local LLM constrained to retrieved sources, not verified by a legal professional. Always open the cited article before relying on it.
- **Local, single-user by design.** The retrieval API has no authentication, authorization, or rate limiting and is meant to run on `localhost` for one trusted user — see [Security](#security).
- **Model tags and Python dependencies are configurable but not fully lock-pinned yet.** Record model versions and evaluation results when publishing experiments.

## Requirements

- Docker with Compose
- [Ollama](https://ollama.com)
- Python 3.12+
- Node.js 20.19+ (or 22.12+) and pnpm
- Rust, only if building the Tauri desktop shell

## Quick start

```bash
cp .env.example .env
docker compose up -d

ollama serve
ollama pull bge-m3
ollama pull qwen2.5:3b-instruct
```

Create the ingestion environment and build the local corpus:

```bash
cd apps/ingestion
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
ingest resolve && ingest fetch && ingest parse && ingest embed
```

Start the API in a second terminal:

```bash
cd apps/retrieval
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
python -m uvicorn retrieval.app:app --host 127.0.0.1 --port 8000
```

Run the desktop client in a third terminal:

```bash
cd apps/desktop
pnpm install
pnpm tauri dev
```

Component-specific setup, corpus refresh behavior, evaluation workflow, and troubleshooting live in the [ingestion](apps/ingestion/README.md), [retrieval](apps/retrieval/README.md), [evals](apps/evals/README.md), and [desktop](apps/desktop/README.md) READMEs. The `/search` and `/chat` request/response contracts, including the SSE event schema, are documented in the [retrieval API reference](apps/retrieval/README.md#api).

## Evaluation

`apps/evals` scores the retrieval API against a gold Q&A dataset (German/French/Italian) built from the indexed corpus, with a human-curated seed set plus an LLM-assisted drafting workflow for growing it. Target scorecard:

| Metric             | Target |
| ------------------ | ------ |
| Retrieval hit rate  | ≥ 0.80 |
| Keyword recall      | ≥ 0.70 |
| Refusal accuracy    | ≥ 0.90 |

Scorecard pending the first full run against a fully embedded corpus.

## Security

The service is designed for one trusted local user with no built-in authentication. Keep PostgreSQL, Ollama, and the retrieval API bound to `127.0.0.1`, never place real secrets in a committed `.env`, and report suspected vulnerabilities privately rather than in a public issue. Full policy: [SECURITY.md](SECURITY.md).

## Development

Each Python component has offline tests plus Ruff and mypy configuration:

```bash
cd apps/ingestion && pytest && ruff check . && mypy ingestion
cd ../retrieval && pytest -m "not db" && ruff check . && mypy retrieval
cd ../evals && pytest && ruff check . && mypy evals
cd ../desktop && pnpm test && pnpm build
```

The default test suites do not require live Fedlex, PostgreSQL, Ollama, or Hugging Face; integration tests are explicitly marked and skip automatically when their dependency is unavailable. CI runs the same checks — Ruff, mypy, pytest per Python app, and the desktop test/build — on every push and pull request to `master`.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Status

| Milestone                                              | State |
| ------------------------------------------------------- | ----- |
| 0 — Repo scaffold, Docker Compose, README                | ✅    |
| 1 — SPARQL resolve + fetch (10-act corpus)                | ✅    |
| 2 — Akoma Ntoso parser → article chunks                   | ✅    |
| 3 — Embed + index + hybrid search + rerank                | 🟡 code complete* |
| 4 — `/chat` with citation contract + SSE                  | 🟡 code complete* |
| 5 — Tauri desktop UI                                       | 🟡 code complete* |
| 6 — Gold dataset + eval scorecard                          | 🟡 code complete* |
| 7 — Hardening + release readiness (lint/CI, security & contributing docs) | 🟡 in progress |

\* implemented and unit-tested; end-to-end verification against a fully embedded corpus is still pending.

## Data and licensing

This repository's MIT license covers the project code. Swiss federal law texts are official works without copyright protection (Art. 5 URG); reuse of Fedlex data is expressly authorized. Retain source attribution and verify the current Fedlex reuse terms before redistributing a downloaded corpus. Do not commit `.env`, downloaded data, model weights, evaluation results containing sensitive material, or private project notes.

## License

[MIT](LICENSE)
