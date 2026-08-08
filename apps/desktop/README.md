# Desktop client

Tauri 2 + React + Vite desktop client for the retrieval API. It renders streamed answers, optional model reasoning, source cards, resolved citation links, and ingestion progress. The client talks only to `http://localhost:8000`; it never connects to PostgreSQL directly.

## Prerequisites

- Node.js 20.19+ or 22.12+ and pnpm
- Rust and the platform prerequisites listed in the [Tauri guide](https://tauri.app/start/prerequisites/)
- The retrieval API, PostgreSQL, Ollama, and an embedded corpus; see [retrieval](../retrieval/README.md)

## Run and verify

```bash
pnpm install
pnpm tauri dev
```

Frontend-only checks do not require Rust:

```bash
pnpm test
pnpm build       # TypeScript check + Vite production bundle
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:8000` | Retrieval API base URL at build time |
| `VITE_SHOW_THINKING` | `false` | Show the expandable model-reasoning disclosure at build time |
| `VITE_API_KEY` | (empty) | Sent as `X-API-Key` on every request when set — pair with the retrieval API's opt-in `API_KEY` (see `apps/retrieval/README.md` Security) |

Keep the API local unless you add authentication, authorization, and an appropriate CORS policy. The backend is intentionally a trusted-local-user service; `VITE_API_KEY`/`API_KEY` add opt-in request authentication, not multi-tenant security.

## Behavior

- The composer is disabled until `/health` responds successfully.
- A chat shows sources first, accumulates optional `thinking` events separately, then streams answer tokens. Reasoning is never used for citation extraction. The expandable reasoning view is a debug feature, off by default (`VITE_SHOW_THINKING`) — raw model reasoning can be unpredictable and is not intended for end users. With the flag off, the transcript still shows a static "Searching articles…" / "Thinking…" indicator; the flag only gates the expandable disclosure of the reasoning text itself.
- A mid-stream error preserves the partial answer; Stop aborts the request and marks the partial answer as stopped.
- The corpus panel starts the server-side `resolve -> fetch -> parse -> embed` pipeline and displays live progress. Closing it does not cancel ingestion.
- Updating the corpus only re-embeds new or changed articles — expect a long CPU-bound job on first ingest, but reruns are incremental (see `apps/ingestion/README.md`).
- Sources are scoped to the latest selected answer and open their official Fedlex ELI links in the system browser.
