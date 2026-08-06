# desktop

Tauri 2 + Vite + React + Tailwind + HeroUI chat UI over the retrieval API: SSE-streamed answers, citation chips that open the cited Fedlex article in the system browser, DE/FR/IT question-language switcher, and a panel showing the articles retrieved for the latest answer. Talks only to `http://localhost:8000` — never to Postgres directly.

## Prerequisites

- Node.js ≥ 20 and pnpm (`npm install -g pnpm`)
- Rust toolchain (rustup) + Tauri system dependencies — WebView2 ships with Windows 11; `webkit2gtk` on Linux ([Tauri prerequisites](https://tauri.app/start/prerequisites/))
- The retrieval API running with its own prerequisites (Postgres, Ollama, embedded corpus) — see [`../retrieval/README.md`](../retrieval/README.md)

## Run

```
pnpm install
pnpm tauri dev
```

Frontend-only checks (no Rust needed):

```
pnpm test    # Vitest + React Testing Library
pnpm build   # type-check + production bundle
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:8000` | Base URL of the retrieval API (build-time; put it in `.env`, see `.env.example`) |

## Behavior notes

- The composer is disabled until `GET /health` succeeds (status dot in the header).
- Answers stream token-by-token; when generation fails mid-stream the partial text is kept and the error is shown on the message.
- The first `/chat` after backend start takes ~30 s (lazy reranker load — see the retrieval README).
