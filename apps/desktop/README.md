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

## Interface

The window is split into three collapsible zones: a conversation sidebar on the left, the chat transcript in the center, and a sources panel on the right.

### Theme and language

The interface uses a dedicated "chancery" HeroUI theme (`chancery-light` / `chancery-dark`) — near-black and white surfaces with Swiss red (`#d52b1e` light, `#ff4438` dark) as the only accent. By default it follows the OS light/dark preference, including live changes while the app is running. A header dropdown, between the backend status dot and the settings gear, overrides this with an explicit System / Light / Dark choice; the chosen mode persists to `localStorage` (`slr.theme`) across restarts. The resolved theme is also applied before the app's own JavaScript runs, so switching or restarting never shows a flash of the wrong background.

UI copy is available in English, German, French, Italian, and European Portuguese; switch it from Settings > General. The corpus itself is only indexed in German, French, and Italian, so English and Portuguese fall back to the closest corpus language (German and French, respectively) when searching or asking a question — answer text still reflects the retrieved source language.

### Jurisdiction

Settings > General also has a Jurisdiction picker: "None — federal law only" (the default) or one of the 26 cantons. Selecting a canton sends its two-letter code as `canton` on every `/search` and `/chat` request; the server includes that canton's law in the results alongside the federal corpus. Cantons without an ingested corpus yet are still selectable — they show a "federal only" badge in the dropdown and behave exactly like "None" until that canton is ingested (currently SG and BE are covered; see the root README's Coverage table). The choice persists locally and is recorded in the Activity tab's audit trail.

Cantonal sources render with their own citation label (e.g. `sGS 811.1 Art. 2` for St. Gallen, `BSG 661.11 Art. 2` for Bern) instead of the federal `SR <number>` form, and their citation chips and "Open in official portal" links point at that canton's own legal-text site (`gesetzessammlung.sg.ch` for SG, `belex.sites.be.ch` for BE) rather than Fedlex — the client only ever opens URLs on an allowlist of known official portals, federal and cantonal.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Open the article search palette (press again to close it) |
| `Ctrl+N` | Start a new conversation |
| `Ctrl+B` | Toggle the left sidebar |
| `Ctrl+J` | Toggle the right sources panel |
| `Ctrl+,` | Open Settings |

Shortcuts are handled inside the window only (no OS-global registration) and are suppressed while typing in a text field, except `Ctrl+K` and `Ctrl+N`, which always work. On macOS, `Cmd` is accepted in place of `Ctrl`.

### Conversation history

Conversations and messages persist locally in a SQLite database (via `tauri-plugin-sql`) and survive app restarts. The sidebar lists conversations by most recently updated, and supports resuming, inline renaming, and deletion (with a confirm popover). Timestamps are stored as ISO-8601 UTC strings.

The database file, `conversations.db`, lives in the OS-standard per-app configuration directory:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\com.samusafe.swiss-legal-rag\conversations.db` |
| macOS | `~/Library/Application Support/com.samusafe.swiss-legal-rag/conversations.db` |
| Linux | `~/.config/com.samusafe.swiss-legal-rag/conversations.db` |

### Corpus search and the article reader

A Spotlight-style search palette, opened from the header trigger or `Ctrl+K`, calls the retrieval API's `POST /search` directly (not the chat endpoint) with a `{q, k, lang}` JSON body, returning ranked article chunks with a relevance bar as you type. Because retrieval runs on CPU-only hardware, a search can take anywhere from a few seconds to about a minute; the palette shows a persistent spinner and status label for the whole wait rather than appearing to hang. Results are navigable with the arrow keys and select with Enter or a click.

Selecting a palette result, clicking a citation chip in the chat transcript, or clicking a source card opens the same article reader modal, backed by `GET /article`. It shows the complete article text (not just the retrieved chunk) with DE/FR/IT tabs to switch language on the spot, `←`/`→` navigation across the set of articles it was opened with (every citation in an answer, or the palette's result list), and an "Open official source" button that opens the article's official page in the system browser — Fedlex for federal acts, the canton's own LexWork portal for cantonal acts — anchored to that specific article for the vast majority of entries (a handful of ambiguous anchors fall back to the act's page instead of a wrong one). A language tab for a translation the corpus doesn't have is disabled rather than hidden.

In the chat transcript, each `[<collection> <number> Art. <x>]` citation (`SR 220 Art. 335c` for federal law, `sGS 811.1 Art. 2` or `BSG 661.11 Art. 2` for the cantonal pilots) renders as a clickable chip; an answer that cites several articles in one bracket (e.g. `[SR 220 Art. 1, Art. 2]`) renders one chip per reference, each independently opening the reader on that article. Answers that cite nothing (including refusals) show no sources panel entries.

## Behavior

- The composer is disabled until `/health` responds successfully.
- A chat shows sources first, accumulates optional `thinking` events separately, then streams answer tokens. Reasoning is never used for citation extraction. The expandable reasoning view is a debug feature, off by default (`VITE_SHOW_THINKING`) — raw model reasoning can be unpredictable and is not intended for end users. With the flag off, the transcript still shows a static "Searching articles…" / "Thinking…" indicator; the flag only gates the expandable disclosure of the reasoning text itself.
- A mid-stream error preserves the partial answer; Stop aborts the request and marks the partial answer as stopped. Either way, the partial answer is saved to the conversation's history, not just kept on screen.
- The header gear (or `Ctrl+,`) opens Settings — General (UI language, native OS notifications), Corpus, Export, and Activity tabs.
- The Corpus tab starts the server-side `resolve -> fetch -> parse -> embed` pipeline and displays live progress. Progress is tracked by a persistent app-level subscription to the server's progress stream that stays attached for the whole session, so closing and reopening the panel does not lose or restart it. Closing the panel does not cancel ingestion; a Stop button (with a confirm popover) cancels the current phase server-side.
- Updating the corpus only re-embeds new or changed articles — expect a long CPU-bound job on first ingest, but reruns are incremental (see `apps/ingestion/README.md`).
- With OS notifications enabled (Settings > General; on by default, permission requested on enable), finishing an answer while the window is in the background shows a native notification with the answer's first line.
- The Export tab saves any conversation as JSON or Markdown via the native save dialog.
- The Activity tab shows a local audit trail of chat, search, reading, conversation-management, and error events, stored in the same local SQLite database as conversation history. It shows a per-group 7-/30-day event count summary, filters by group and by a 7/30/90-day range, paginates the results, and exports the full log as JSONL via the native save dialog. Events older than 90 days are pruned automatically on startup.
- Sources are scoped to the latest selected answer, show relevance as a percentage, and open the article reader on click.

## Icon

The application icon (scales of justice, white beam with Swiss-red pans on a near-black background) is original artwork created for this project. It is not a third-party asset and carries no license obligation.
