"""LLM-assisted gold-question drafting CLI.

Samples chunks from the ingestion pipeline's `data/chunks/<sr>/<lang>.jsonl`
output and asks a local Ollama chat model to draft one exam-style question
per chunk, in the chunk's own language, answerable from the article text
alone. Output is written as a `gold.jsonl`-shaped file that a human curator
must review before promoting rows into `data/gold.jsonl` — draft rows are
never auto-merged into the real gold dataset.

Only the pure helpers below (chunk sampling, prompt building, model-output
parsing, row assembly) are unit tested; the Ollama HTTP call itself is not
covered by tests (no live-Ollama dependency in the test suite).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv()  # repo-root .env; defaults mirror .env.example — must run before
# DEFAULT_MODEL below reads OLLAMA_CHAT_MODEL from the environment.

DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = os.environ.get("OLLAMA_CHAT_MODEL", "qwen2.5:3b-instruct")
DEFAULT_CHUNKS_DIR = Path(__file__).resolve().parents[3] / "data" / "chunks"
DEFAULT_OUT = Path("data/gold.draft.jsonl")
_MIN_KEYWORDS = 2
_MAX_KEYWORDS = 4

_SYSTEM_PROMPT = (
    "You are drafting evaluation questions for a Swiss legal RAG system. "
    "Given one article of Swiss federal law, write exactly one exam-style "
    "question that a person could ask and that is fully answerable from the "
    "article text alone. The question must be written in the article's own "
    "language. Also give 2 to 4 short keywords, in that same language, that "
    "a correct answer would contain. Respond with strict JSON only, no "
    'markdown, matching: {"question": "...", "keywords": ["...", "..."]}.'
)


def _load_chunks(chunks_dir: Path, lang: str) -> list[dict]:
    chunks: list[dict] = []
    for act_dir in sorted(p for p in chunks_dir.iterdir() if p.is_dir()):
        chunk_file = act_dir / f"{lang}.jsonl"
        if not chunk_file.exists():
            continue
        for line in chunk_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            chunks.append(json.loads(line))
    return chunks


def sample_chunks(chunks_dir: Path, lang: str, count: int, rng: random.Random) -> list[dict]:
    """Sample up to `count` chunks of `lang` from across all acts in `chunks_dir`."""
    pool = _load_chunks(chunks_dir, lang)
    if not pool:
        raise ValueError(f"no chunks found for lang={lang!r} under {chunks_dir}")
    return rng.sample(pool, k=min(count, len(pool)))


def build_chat_request(chunk: dict, model: str) -> dict:
    """Build the JSON body for Ollama's non-streaming `/api/chat` endpoint."""
    user_prompt = (
        f"Article language: {chunk['lang']}\n"
        f"SR {chunk['sr']} Art. {chunk['article']}\n\n"
        f"{chunk['text']}"
    )
    return {
        "model": model,
        "stream": False,
        "think": False,
        "format": "json",
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    }


def _strip_code_fence(content: str) -> str:
    text = content.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.endswith("```"):
            text = text[: -len("```")]
    return text.strip()


def parse_model_output(content: str) -> dict:
    """Parse and validate a model's draft-question JSON response.

    Raises `ValueError` (with a message suitable for a stderr warning) on
    any malformed output: invalid JSON, missing fields, empty question, or
    a keyword list outside the 2-4 entry range.
    """
    text = _strip_code_fence(content)
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise ValueError(f"model output is not valid JSON: {error}") from error

    if not isinstance(data, dict):
        raise ValueError(f"model output is not a JSON object: {data!r}")

    question = data.get("question")
    if not isinstance(question, str) or not question.strip():
        raise ValueError(f"model output missing non-empty 'question': {data!r}")

    keywords = data.get("keywords")
    if not isinstance(keywords, list) or not all(isinstance(k, str) and k.strip() for k in keywords):
        raise ValueError(f"model output 'keywords' must be a list of strings: {data!r}")
    if not (_MIN_KEYWORDS <= len(keywords) <= _MAX_KEYWORDS):
        raise ValueError(
            f"model output 'keywords' must have {_MIN_KEYWORDS}-{_MAX_KEYWORDS} entries, "
            f"got {len(keywords)}: {data!r}"
        )

    return {"question": question.strip(), "keywords": keywords}


def build_gold_row(chunk: dict, parsed: dict, index: int) -> dict:
    """Assemble one gold-dataset row from a chunk and its parsed model output."""
    return {
        "id": f"draft-{chunk['lang']}-{index}",
        "lang": chunk["lang"],
        "question": parsed["question"],
        "expected_sources": [f"SR {chunk['sr']} Art. {chunk['article']}"],
        "expected_keywords": parsed["keywords"],
        "must_refuse": False,
    }


def _draft_row(
    http_client: httpx.Client, ollama_url: str, chunk: dict, model: str, index: int
) -> dict | None:
    """Call Ollama for one chunk and return a gold row, or None if drafting failed.

    Warns to stderr and returns None on any request failure or malformed
    model output — callers must never let one bad chunk crash the batch.
    """
    request = build_chat_request(chunk, model)
    try:
        response = http_client.post(f"{ollama_url}/api/chat", json=request)
        response.raise_for_status()
        content = response.json()["message"]["content"]
        parsed = parse_model_output(content)
    except Exception as error:  # noqa: BLE001 — logged and skipped, batch continues
        source = f"SR {chunk['sr']} Art. {chunk['article']}"
        print(f"warning: skipping {source} ({chunk['lang']}): {error}", file=sys.stderr)
        return None
    return build_gold_row(chunk, parsed, index)


def draft(
    chunks_dir: Path,
    lang: str,
    count: int,
    model: str,
    out_path: Path,
    ollama_url: str,
    rng: random.Random,
) -> Path:
    chunks = sample_chunks(chunks_dir, lang, count, rng)

    rows: list[dict] = []
    with httpx.Client(timeout=120.0) as http_client:
        for index, chunk in enumerate(chunks, start=1):
            row = _draft_row(http_client, ollama_url, chunk, model, index)
            if row is not None:
                rows.append(row)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "// LLM-drafted gold questions — UNVERIFIED. A human curator must\n"
        "// check each row's question, expected_sources, and\n"
        "// expected_keywords against the source article before merging any\n"
        "// of these into data/gold.jsonl.\n"
    )
    body = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
    out_path.write_text(header + body + ("\n" if body else ""), encoding="utf-8")
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Draft gold-dataset questions from indexed chunks via a local Ollama model."
    )
    parser.add_argument("--lang", required=True, choices=["de", "fr", "it"])
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--chunks-dir", type=Path, default=DEFAULT_CHUNKS_DIR)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--seed", type=int, default=None, help="RNG seed for reproducible sampling")
    args = parser.parse_args()

    rng = random.Random(args.seed)
    out_path = draft(
        chunks_dir=args.chunks_dir,
        lang=args.lang,
        count=args.count,
        model=args.model,
        out_path=args.out,
        ollama_url=DEFAULT_OLLAMA_URL,
        rng=rng,
    )
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
