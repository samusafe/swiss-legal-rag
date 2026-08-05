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
apps/desktop/    Tauri 2 + Vite + React chat UI (calls retrieval API, never Postgres directly)
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

## Model routing

- Main thread (session model): architecture, spec changes, Akoma Ntoso parsing logic, retrieval/eval design — the judgment-heavy work.
- Subagents on cheaper models: `haiku` for mechanical sweeps (renames, doc sync, boilerplate, broad searches); `sonnet` for standard implementation and single-pass code review.
- `opus` subagents for hard delegated work where `sonnet` falls short: Akoma Ntoso parser edge cases, hybrid-search/RRF tuning, adversarial review before closing a milestone.
- One review pass per change; don't stack multiple review agents on small diffs.
- Verify before claiming done: run the relevant check (`pytest`, `cargo check`, `tsc`) instead of a re-read.

## Token discipline

- Read `docs/swiss-legal-rag.md` by section (offset/limit), not whole-file, once you know the spec.
- Prefer Glob/Grep over directory listings; read only files you will edit.
- `data/raw/` XML files are huge — never read whole; Grep the target `eId`/article and read a narrow window around it.
- Never read `node_modules/`, `src-tauri/target/`, `.venv/`, or `data/raw/` listings into context.
- Broad multi-file searches go to an Explore subagent; keep main context for decisions.
- Keep this file and per-app READMEs short — link to the spec instead of duplicating it.
