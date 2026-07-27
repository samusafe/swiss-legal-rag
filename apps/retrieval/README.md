# retrieval

FastAPI service (spec §5–6): `/search` (hybrid pgvector + FTS with RRF, then cross-encoder rerank) and `/chat` (RAG with citation contract, SSE streaming). The only component that talks to Postgres and Ollama.

Not implemented yet — Milestone 3–4.
