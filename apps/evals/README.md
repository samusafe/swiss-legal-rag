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

Each JSONL row contains `id`, `lang` (`de`, `fr`, or `it`), `question`, `expected_sources`, `expected_keywords`, and `must_refuse`. Answerable sources use `SR <number> Art. <article>`; refusal rows have no expected source.

## Run

Start the retrieval API with an embedded corpus, then run:

```bash
python -m evals.run --retrieval-only --k 5
python -m evals.run --k 5
```

`EVALS_API_BASE_URL` and `OLLAMA_CHAT_MODEL` come from the repo-root `.env` (see `.env.example`). Full chat mode over the 60-question gold set takes roughly 30-90 minutes on CPU, hence the 300 s client timeout.

Results are written under `results/`, which is ignored by Git. Use `--dataset` and `--out-dir` to override defaults. The default dataset is `data/gold.jsonl`, falling back to `data/gold.seed.jsonl`.

Retrieval mode measures hit rate. Chat mode additionally measures citation precision/recall, keyword recall, and refusal behavior. These are regression signals, not proof of legal correctness: citation scoring is based on structured citation resolution, keyword recall is lexical, and a human must inspect answer quality and source validity.

Optional drafting requires Ollama and the chat model:

```bash
python -m evals.draft --lang de --count 20 --seed 1
```

Review every generated row against the cited article before merging it into `gold.jsonl`. `--mlflow` is optional and requires a separate `pip install mlflow`.

## Compare runs

```bash
python -m evals.compare results/eval_chat_<old>.json results/eval_chat_<new>.json
```

The comparison command reports regressions and improvements and is informational; it does not currently fail a build.

## Tests and checks

```bash
pytest -q
ruff check evals tests
mypy evals
```
