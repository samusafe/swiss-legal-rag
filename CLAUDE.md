# Swiss Legal RAG — Agent Guide

Multilingual RAG over Swiss federal law (DE/FR/IT). Fully local, zero-cost, public portfolio repo.
**Source of truth:** `docs/swiss-legal-rag.md` (spec, corpus, models, milestones). Read the relevant section before structural decisions — do not re-derive scope from scratch.

## Hard rules

- **Git is read-only.** Never run `git commit`, `push`, `add`, branch/tag creation, or any state-changing git command. The owner handles all git writes. Suggesting a commit message is fine.
- **Public repo — sanitize everything.** No secrets, tokens, personal data, or machine-specific paths in committed files. New env vars go in `.env.example` with placeholder values; real values only in `.env` (git-ignored).
- **Zero cost.** No paid APIs, no API keys, no cloud services. Ollama + Docker Postgres + CPU only.
- **English only** in code, comments, docs, and filenames.
- `data/raw/` is a cache of official Fedlex XML — never commit it, never scrape HTML (structured XML via SPARQL only, ~1 req/s).

## Layout

```
apps/web/        Next.js chat UI (calls retrieval API, never Postgres directly)
apps/retrieval/  FastAPI — /search (hybrid + rerank), /chat (RAG + SSE)
apps/ingestion/  Python CLI — resolve → fetch → parse → embed (per corpus.yaml)
db/init/         SQL run on first Postgres boot (pgvector extension)
docs/            Project spec
corpus.yaml      List of acts (SR numbers) — adding an act = one entry here
```

## Commands

```
docker compose up -d      # Postgres 16 + pgvector on ${POSTGRES_PORT:-5432}
docker compose down       # stop (add -v to wipe data)
cp .env.example .env      # first-time setup
```

App-level commands live in each `apps/*/README.md` once implemented.

## Code style

- **YAGNI:** build only what the current milestone needs; no speculative abstractions, config flags, or "future-proofing".
- **KISS:** prefer the boring solution; one obvious way per problem; small functions, flat control flow.
- **Readability first:** clear names over comments; comment only non-obvious constraints (legal/data quirks, rate limits).
- Python: type hints everywhere, `pydantic` models at boundaries. TypeScript: `strict`, no `any`.
- Errors: fail loud with context; never swallow exceptions.
- Every generated answer must cite `[SR <nr> Art. <x>]` — un-cited claims are defects (see spec §5).

## Token discipline

- Read `docs/swiss-legal-rag.md` by section (offset/limit), not whole-file, once you know the spec.
- Prefer Glob/Grep over directory listings; read only files you will edit.
- Keep this file and per-app READMEs short — link to the spec instead of duplicating it.
