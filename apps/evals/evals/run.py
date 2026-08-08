"""Retrieval-only / chat eval runner: loads the gold dataset, calls the
retrieval API for every question, scores each row, and writes a results JSON.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import httpx
from dotenv import load_dotenv

from evals.client import auth_headers, chat, search
from evals.dataset import GoldQuestion, load_gold
from evals.metrics import citation_scores, keyword_recall, refusal_ok, retrieval_hit, summarize

DEFAULT_BASE_URL = "http://localhost:8000"
DEFAULT_DATASET = Path("data/gold.jsonl")
FALLBACK_DATASET = Path("data/gold.seed.jsonl")

Clock = Callable[[], float]


def _empty_row(question: GoldQuestion) -> dict:
    return {
        "id": question.id,
        "lang": question.lang,
        "hit": None,
        "citation_precision": None,
        "citation_recall": None,
        "keyword_recall": None,
        "refusal_ok": None,
        "latency_s": 0.0,
        "error": None,
    }


def _score_question(
    question: GoldQuestion,
    mode: str,
    k: int,
    base_url: str,
    http_client: httpx.Client,
    clock: Clock,
    api_key: str | None = None,
) -> dict:
    row = _empty_row(question)
    start = clock()
    try:
        results = search(
            http_client, base_url, question.question, question.lang, k, api_key
        )
        row["hit"] = retrieval_hit(results, question.expected_sources)

        if mode != "retrieval":
            answer, citations = chat(
                http_client, base_url, question.question, question.lang, k, api_key
            )
            row["citation_precision"], row["citation_recall"] = citation_scores(
                citations, question.expected_sources
            )
            row["keyword_recall"] = keyword_recall(answer, question.expected_keywords)
            row["refusal_ok"] = refusal_ok(citations, question.must_refuse, answer)
    except Exception as error:  # noqa: BLE001 — recorded per-row, run continues
        row["error"] = str(error)
    row["latency_s"] = clock() - start
    return row


_CORPUS_FIELDS = ("acts", "chunks_total", "chunks_embedded")


def _corpus_provenance(
    http_client: httpx.Client, base_url: str, api_key: str | None = None
) -> dict | None:
    """Best-effort GET /ingest/status, trimmed to the provenance subset. Never
    fails the run — any error (unreachable API, non-2xx, bad JSON) yields None."""
    try:
        response = http_client.get(
            f"{base_url}/ingest/status", headers=auth_headers(api_key)
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError):
        return None
    return {field: payload.get(field) for field in _CORPUS_FIELDS}


def _run_git(args: list[str]) -> str | None:
    """Run a read-only git command from `evals/`'s own directory (inside the
    repo regardless of the caller's cwd). Never raises -- any failure
    (git missing, not a repo, timeout) yields None so a run_manifest field
    never crashes the run."""
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=Path(__file__).resolve().parent,
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout


def _git_info() -> dict:
    sha_output = _run_git(["rev-parse", "HEAD"])
    commit_sha = sha_output.strip() if sha_output is not None else None
    if commit_sha is not None and len(commit_sha) != 40:
        commit_sha = None

    status_output = _run_git(["status", "--porcelain"])
    dirty = bool(status_output.strip()) if status_output is not None else None

    return {"commit_sha": commit_sha, "dirty": dirty}


def _build_run_manifest(dataset: Path, k: int, timestamp: datetime) -> dict:
    return {
        "schema_version": 1,
        "timestamp_utc": timestamp.isoformat(),
        "git": _git_info(),
        "eval_set_sha256": hashlib.sha256(dataset.read_bytes()).hexdigest(),
        "chat_model": os.environ.get("OLLAMA_CHAT_MODEL"),
        "embedding_model": os.environ.get("OLLAMA_EMBED_MODEL"),
        "retrieval": {"k": k},
        "python_version": platform.python_version(),
    }


def run(
    dataset: Path,
    mode: str,
    k: int,
    base_url: str,
    out_dir: Path,
    clock: Clock = time.perf_counter,
    client: httpx.Client | None = None,
    permissive: bool = False,
) -> Path:
    questions = load_gold(dataset, permissive=permissive)
    # Read directly from the environment (rather than a parameter) so this
    # works whether `main()` (which calls `load_dotenv()`) or `run()` itself
    # is the entry point — e.g. called as a library, or from tests via
    # `monkeypatch.setenv`. Sent as `X-API-Key` on every retrieval API call
    # below; a no-op when the API doesn't require auth (API_KEY unset there).
    api_key = os.environ.get("API_KEY")

    owns_client = client is None
    # CPU-only hosts: a cold /search loads bge-m3 + the reranker (~80 s) and a
    # warm rerank alone takes ~30 s, so 60 s timed out every question.
    http_client = client if client is not None else httpx.Client(timeout=300.0)
    try:
        corpus = _corpus_provenance(http_client, base_url, api_key)
        rows = [
            _score_question(question, mode, k, base_url, http_client, clock, api_key)
            for question in questions
        ]
    finally:
        if owns_client:
            http_client.close()

    started = datetime.now(timezone.utc)
    result = {
        "mode": mode,
        "model": os.environ.get("OLLAMA_CHAT_MODEL"),
        "k": k,
        "dataset": str(dataset),
        "started": started.isoformat(),
        "corpus": corpus,
        "questions": rows,
        "summary": summarize(rows),
        "run_manifest": _build_run_manifest(dataset, k, started),
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_path = out_dir / f"eval_{mode}_{timestamp}.json"
    out_path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    return out_path


def log_to_mlflow(result: dict, out_path: Path) -> None:
    """Log a results dict (as written by `run`) to MLflow.

    `mlflow` is an optional dependency: it is only imported here, inside the
    `--mlflow` code path, so the rest of the eval harness works without it.
    """
    try:
        import mlflow
    except ImportError as error:
        raise RuntimeError(
            "MLflow logging requires the 'mlflow' package; run `pip install mlflow`."
        ) from error

    with mlflow.start_run():
        mlflow.log_params(
            {
                "mode": result["mode"],
                "k": result["k"],
                "dataset": result["dataset"],
                "model": result["model"],
            }
        )
        for key, value in result["summary"].items():
            if value is not None:
                mlflow.log_metric(key, value)
        mlflow.log_artifact(str(out_path))


def _resolve_dataset(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit
    return DEFAULT_DATASET if DEFAULT_DATASET.exists() else FALLBACK_DATASET


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Score the retrieval API against a gold question dataset."
    )
    parser.add_argument(
        "--retrieval-only",
        action="store_true",
        help="score raw /search hits instead of full /chat answers",
    )
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument(
        "--dataset",
        type=Path,
        default=None,
        help="defaults to data/gold.jsonl, falling back to data/gold.seed.jsonl",
    )
    parser.add_argument("--out-dir", type=Path, default=Path("results"))
    parser.add_argument(
        "--mlflow",
        action="store_true",
        help="log the run's params and summary metrics to MLflow",
    )
    parser.add_argument(
        "--permissive-eval-set",
        action="store_true",
        help="skip invalid gold rows (logged to stderr) instead of erroring; "
        "still fails if no valid row remains",
    )
    args = parser.parse_args()

    load_dotenv()  # repo-root .env; defaults mirror .env.example

    dataset = _resolve_dataset(args.dataset)
    mode = "retrieval" if args.retrieval_only else "chat"
    base_url = os.environ.get("EVALS_API_BASE_URL", DEFAULT_BASE_URL)

    out_path = run(
        dataset,
        mode,
        args.k,
        base_url,
        args.out_dir,
        permissive=args.permissive_eval_set,
    )
    print(f"wrote {out_path}")

    if args.mlflow:
        result = json.loads(out_path.read_text(encoding="utf-8"))
        log_to_mlflow(result, out_path)


if __name__ == "__main__":
    main()
