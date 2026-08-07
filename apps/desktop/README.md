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
- The corpus icon in the header opens the Corpus panel: one "Update corpus" button runs the
  full ingestion pipeline server-side with a live embedding progress bar. Closing the panel
  never stops a run; chat stays usable while embedding (results may be incomplete until done).
- The Stop button aborts the in-flight stream and keeps whatever partial answer already
  arrived, marked "stopped".
- While waiting for a response, a thinking indicator shows "Searching articles…" until the
  retrieved sources arrive, then "Thinking…" until the first answer token streams in.
- The sources panel always shows the latest answer's results only, one card per article (the
  best-scored part, for articles split across multiple chunks). The relevance bar is scaled
  relative to the other results in that answer's set, not an absolute score — the raw score is
  shown beside it. A "Cited" badge marks the articles the answer actually cited inline.
- Clicking a previous answer bubble selects it (highlighted ring) and switches the sources
  panel to that answer's articles ("answer N" in the panel header); clicking it again — or
  asking a new question — returns to the latest answer.
