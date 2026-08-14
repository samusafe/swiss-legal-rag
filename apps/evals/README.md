# Evaluation harness

Scores the local retrieval API against a gold Swiss-legal-question dataset in German, French, and Italian. It also provides an LLM-assisted drafting workflow; drafted questions are never treated as gold until a human verifies them.

## Setup

```bash
cd apps/evals
python -m venv .venv
# Windows: .venv\Scripts\activate; Linux/macOS: source .venv/bin/activate
pip install -r requirements-dev.txt -e .
```

## Dataset

`data/gold.seed.jsonl` is the checked-in 33-row balanced seed set (11 questions per language,
including answerable and refusal cases). `data/gold.jsonl` is the curated run dataset and is
intentionally created locally. `data/gold.draft*.jsonl` is ignored because LLM-generated rows
require human verification.

Each JSONL row contains `id`, `lang` (`de`, `fr`, or `it`), `question`, `expected_sources`, `expected_keywords`, and `must_refuse`. Answerable sources use the compound citation grammar `<collection> <number> Art. <article>` — `SR 220 Art. 335c` for a federal act, `sGS 811.1 Art. 2` for St. Gallen, `BSG 661.11 Art. 2` for Bern; refusal rows have no expected source. An optional `expected_source_ids` field is accepted for compatibility with upstream-authored datasets; it is stored but never scored.

The checked-in seed set is federal-only today. Cantonal gold rows (SG/BE) are added once the corresponding canton has an ingested corpus to score against — see the root README's Coverage table for what's currently ingested.

Loading is fail-closed by default (`load_gold(path)`): an unknown key, a duplicate `id` across rows, or a blank/whitespace-only `id`/`question` all abort the load with a `ValueError` naming the offending line. Pass `permissive=True` (or `--permissive-eval-set` on the CLI, see below) to instead log each bad row to stderr as `skipping line N: <reason>` and continue with the remaining rows — this still raises if no valid row remains.

## Run

Start the retrieval API with an embedded corpus, then run:

```bash
python -m evals.run --retrieval-only --k 5
python -m evals.run --k 5
python -m evals.run --k 5 --permissive-eval-set  # skip invalid gold rows instead of erroring
```

`EVALS_API_BASE_URL` and `OLLAMA_CHAT_MODEL` come from the repo-root `.env` (see `.env.example`). Full chat mode over the 60-question gold set takes roughly 30-90 minutes on CPU, hence the 300 s client timeout. If the retrieval API's `API_KEY` is set, the same `API_KEY` from `.env` is sent as `X-API-Key` on every request.

`--permissive-eval-set` swaps the dataset loader into log-and-skip mode (see Dataset above) — useful when running against a locally curated `gold.jsonl` that hasn't been fully cleaned up yet. The checked-in `gold.seed.jsonl` always loads strict.

Results are written under `results/`, which is ignored by Git. Use `--dataset` and `--out-dir` to override defaults. The default dataset is `data/gold.jsonl`, falling back to `data/gold.seed.jsonl`.

Each results JSON has top-level `mode`, `model`, `k`, `dataset`, `started`, `corpus`, `questions` (per-row scores), `summary`, and `run_manifest`. `corpus` is a best-effort snapshot of the API's `GET /ingest/status` at run time — `{"acts", "chunks_total", "chunks_embedded"}` — or `null` if that request fails for any reason; a corpus snapshot is never allowed to fail the run.

`run_manifest` records what produced the run, for reproducibility when comparing results later:

```json
{
  "schema_version": 1,
  "timestamp_utc": "2026-08-08T12:00:00+00:00",
  "git": {"commit_sha": "…40 hex chars…", "dirty": false},
  "eval_set_sha256": "…sha256 of the dataset file bytes…",
  "chat_model": "qwen3:8b",
  "embedding_model": "bge-m3",
  "retrieval": {"k": 5},
  "python_version": "3.13.5"
}
```

`git.commit_sha`/`git.dirty` and the whole `git` object fall back to `null` if `git` isn't available or the working directory isn't a repository — this never fails the run. `chat_model`/`embedding_model` come from the `OLLAMA_CHAT_MODEL`/`OLLAMA_EMBED_MODEL` env vars and are `null` if unset.

Retrieval mode measures hit rate. Chat mode additionally measures citation precision/recall, keyword recall, and refusal behavior. These are regression signals, not proof of legal correctness: citation scoring is based on structured citation resolution, keyword recall is lexical, and a human must inspect answer quality and source validity.

`refusal_ok` (chat mode only; always `null` in retrieval-only mode, which has no answer to check) is `true` only when a `must_refuse` question resolves zero citations **and** the whole answer equals the canonical refusal sentence ("The current corpus contains no sources sufficient to answer this question.") after normalization (casefold + collapsing whitespace runs to a single space + stripping leading/trailing whitespace). This is an exact match, not a substring match — an answer that adds any extra words before or after the canonical sentence no longer counts as a correct refusal, matching the upstream harness's stricter contract. Zero resolved citations alone still doesn't count either — a model that drops citations without actually declining to answer must not score as a correct refusal.

Optional drafting requires Ollama and the chat model:

```bash
python -m evals.draft --lang de --count 20 --seed 1
```

Review every generated row against the cited article before merging it into `gold.jsonl`. `--mlflow` is optional and requires a separate `pip install mlflow`.

## Compare runs

```bash
python -m evals.compare results/eval_chat_<old>.json results/eval_chat_<new>.json
python -m evals.compare --latest  # picks the two most recent results/eval_*.json by mtime
```

`--latest` searches `--out-dir` (default `results/`) and errors clearly if fewer than two `eval_*.json` files are present. When both runs carry a `run_manifest`, a mismatched `chat_model` or `eval_set_sha256` between them prints a `WARNING` line before the diff — the comparison may not be apples-to-apples (e.g. a different model or a different dataset produced each run). Runs without a `run_manifest` (from before this field existed) are compared without a warning.

The comparison command reports regressions and improvements and is informational; it does not currently fail a build.

## Tests and checks

```bash
pytest -q
ruff check evals tests
mypy evals
```

## Credit

Dataset format and metrics are adapted from [`samusafe/rag-eval-harness`](https://github.com/samusafe/rag-eval-harness), the author's own general-purpose RAG evaluation harness, retargeted here for the SR/Art citation contract and HTTP retrieval API of this project.
