# evals

Scores the local retrieval API (`apps/retrieval`) against a gold Swiss-legal-question dataset
(German/French/Italian), and provides an LLM-assisted CLI for drafting new gold questions from
the indexed corpus. Dataset format and metric design follow
[`samusafe/rag-eval-harness`](https://github.com/samusafe/rag-eval-harness).

## Setup

```
cd apps/evals
python -m venv .venv
# Windows: .venv\Scripts\activate    Linux: source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt -e .
```

## Dataset format

One JSON object per line (`.jsonl`); blank lines and lines starting with `//` are comments and
are skipped. Each row:

| Field                | Type            | Notes                                                        |
| --------------------- | --------------- | ------------------------------------------------------------ |
| `id`                 | `str`           | unique within the file                                       |
| `lang`               | `"de"\|"fr"\|"it"` | question language                                            |
| `question`           | `str`           |                                                               |
| `expected_sources`   | `list[str]`     | `"SR <nr> Art. <x>"`; empty for `must_refuse` rows            |
| `expected_keywords`  | `list[str]`     | terms in the question's language a correct answer would contain |
| `must_refuse`        | `bool`          | `true` for out-of-corpus questions (cantonal law, medical advice, etc.) that the system should decline rather than answer without a source |

`evals.dataset.load_gold` validates every row against this schema and raises with the offending
line number on any violation.

### Files

- `data/gold.seed.jsonl` — 9 hand-written rows (3 per language: 2 answerable + 1 `must_refuse`),
  checked into the repo. Every answerable row's article was verified against the actual indexed
  chunks before being added.
- `data/gold.draft.jsonl` — output of `evals.draft` (git-ignored, machine-local); **unverified**,
  never read directly by `evals.run`.
- `data/gold.jsonl` — the curated dataset actually used for eval runs. Not checked in yet; create
  it by curating draft rows (see below). `evals.run` falls back to `data/gold.seed.jsonl` when it
  doesn't exist.

## Curation workflow

1. Draft candidate questions from the indexed corpus for one language at a time:

   ```
   .venv/Scripts/python.exe -m evals.draft --lang de --count 20 --seed 1
   ```

   Requires a local Ollama running at `http://localhost:11434` (`ollama serve`) with the chat
   model pulled (`--model`, default `$OLLAMA_CHAT_MODEL` or `qwen2.5:3b-instruct`). Samples
   `--count` chunks from `--chunks-dir` (default `<repo>/data/chunks`), asks the model for one
   exam-style question + 2-4 answer keywords per chunk, and writes rows to `--out` (default
   `data/gold.draft.jsonl`). Malformed model output for a chunk is skipped with a warning on
   stderr — the batch never crashes over one bad response. Repeat with `--lang fr` and
   `--lang it`, appending or using separate `--out` files per language.

2. **Human-verify every drafted row** against the cited article before it counts as gold: does
   the question read naturally, is `expected_sources` actually the right article, would a correct
   answer really contain each keyword? Drafted rows are a starting point, not ground truth — the
   model can hallucinate a plausible-sounding but wrong article or keyword.

3. Move verified rows into `data/gold.jsonl` (merge with `data/gold.seed.jsonl`'s rows, or start
   `gold.jsonl` from a copy of the seed file and append). Keep `id`s unique across the merged file.

## Run

Requires the retrieval API running locally (see `apps/retrieval/README.md`) and, for full mode, an
embedded corpus (`apps/ingestion`).

```
.venv/Scripts/python.exe -m evals.run --retrieval-only --k 5
```

Drop `--retrieval-only` to run full mode: every question scores both the raw `/search` hit
and the full `/chat` answer (citation precision/recall, keyword recall, refusal accuracy) in
one pass. Results are written as JSON to `results/eval_<mode>_<timestamp>.json` (override
with `--out-dir`); the `model` field is stamped from `OLLAMA_CHAT_MODEL` if set, else `null`.

**Expect CPU-only timing roughly like this** (varies with hardware and dataset size):

- `--retrieval-only`: a few minutes for the full dataset (no LLM generation, just embed + search).
- Full mode (`/chat`, one local LLM generation per question): **~30-90 minutes for 60 questions**
  on CPU — budget accordingly before kicking off a full run.

`--dataset` overrides the input file; default is `data/gold.jsonl`, falling back to
`data/gold.seed.jsonl` when it doesn't exist yet.

Configuration is read from `.env` at the repo root (`cp .env.example .env` if you haven't) as
well as the process environment. `EVALS_API_BASE_URL` overrides the retrieval API base URL
(default `http://localhost:8000`); `OLLAMA_CHAT_MODEL` is used for the `--model` default of
`evals.draft` and stamped into the `model` field of run results.

`--mlflow` logs the run's params (mode, k, dataset, model) and non-null summary metrics to
MLflow, plus the results JSON as an artifact. Requires `pip install mlflow` (optional,
not in `requirements.txt`); then inspect runs with:

```
mlflow ui
```

## Compare two runs

```
.venv/Scripts/python.exe -m evals.compare results/eval_chat_<old>.json results/eval_chat_<new>.json
```

Prints per-question regressions (a metric going `true` → `false` or numerically down) first,
then improvements, then a summary count. Questions present in only one run are reported
separately. Always exits `0` — this is a report, not a gate.

## Test

```
.venv/Scripts/python.exe -m pytest -q
```
