"""Gold-question dataset loader.

Dataset format: one JSON object per line (`.jsonl`); blank lines and lines
starting with `//` are comments and are skipped.

Validation is fail-closed by default: unknown keys, duplicate ids, and
blank id/question fields all abort the load (matching the upstream
`samusafe/rag-eval-harness` contract). `load_gold(path, permissive=True)`
downgrades this to log-and-skip per bad row, still raising if nothing
usable remains -- see `load_gold` for details.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

from evals.metrics import _SOURCE_RE

_VALID_LANGS = {"de", "fr", "it"}
_REQUIRED_FIELDS = (
    "id",
    "lang",
    "question",
    "expected_sources",
    "expected_keywords",
    "must_refuse",
)
# Accepted but not required, and never scored: upstream's own row identifier,
# kept only so upstream-authored datasets load without a field strip.
_OPTIONAL_FIELDS = ("expected_source_ids",)
_ALLOWED_FIELDS = frozenset(_REQUIRED_FIELDS) | frozenset(_OPTIONAL_FIELDS)


@dataclass(frozen=True)
class GoldQuestion:
    id: str
    lang: str
    question: str
    expected_sources: tuple[str, ...]
    expected_keywords: tuple[str, ...]
    must_refuse: bool
    expected_source_ids: tuple[str, ...] = ()


def _parse_row(data: dict, lineno: int, seen_ids: dict[str, int]) -> GoldQuestion:
    """Validate one already-JSON-decoded row and build a `GoldQuestion`.

    Raises `ValueError` with a bare reason (no path/line prefix -- the caller
    adds that, or logs it as-is in permissive mode).
    """
    unknown_keys = sorted(set(data) - _ALLOWED_FIELDS)
    if unknown_keys:
        raise ValueError(f"unknown field(s) {unknown_keys}")

    for field in _REQUIRED_FIELDS:
        if field not in data:
            raise ValueError(f"missing field {field!r}")

    for field_name in ("id", "question"):
        value = data[field_name]
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{field_name!r} must be a non-blank string, got {value!r}")

    lang = data["lang"]
    if lang not in _VALID_LANGS:
        raise ValueError(f"lang must be one of {sorted(_VALID_LANGS)}, got {lang!r}")

    list_fields = ["expected_sources", "expected_keywords"]
    if "expected_source_ids" in data:
        list_fields.append("expected_source_ids")
    for list_field in list_fields:
        value = data[list_field]
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise ValueError(
                f"{list_field!r} must be a list of strings, got {value!r}"
            )

    must_refuse = data["must_refuse"]
    if not isinstance(must_refuse, bool):
        raise ValueError(f"'must_refuse' must be a bool, got {must_refuse!r}")

    for source in data["expected_sources"]:
        if not _SOURCE_RE.match(source.strip()):
            raise ValueError(
                f'expected_sources entry {source!r} must match "<collection> <nr> Art. <x>"'
            )

    row_id = data["id"]
    if row_id in seen_ids:
        raise ValueError(f"duplicate id {row_id!r} (first seen on line {seen_ids[row_id]})")
    seen_ids[row_id] = lineno

    return GoldQuestion(
        id=row_id,
        lang=lang,
        question=data["question"],
        expected_sources=tuple(data["expected_sources"]),
        expected_keywords=tuple(data["expected_keywords"]),
        must_refuse=must_refuse,
        expected_source_ids=tuple(data.get("expected_source_ids", [])),
    )


def load_gold(path: Path, permissive: bool = False) -> list[GoldQuestion]:
    """Load and validate the gold dataset at `path`.

    `permissive=False` (default): the first invalid row raises `ValueError`
    naming the file, line number, and reason -- the strict behavior used for
    the checked-in gold dataset.

    `permissive=True`: each invalid row is logged to stderr as
    `skipping line N: <reason>` and skipped rather than raised; if no row
    survives, `ValueError` is still raised (an empty eval set is never a
    valid outcome).
    """
    questions: list[GoldQuestion] = []
    seen_ids: dict[str, int] = {}
    lines = path.read_text(encoding="utf-8").splitlines()
    for lineno, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("//"):
            continue

        try:
            data = json.loads(line)
            question = _parse_row(data, lineno, seen_ids)
        except json.JSONDecodeError as error:
            reason = f"invalid JSON ({error})"
            if not permissive:
                raise ValueError(f"{path} line {lineno}: {reason}") from error
            print(f"skipping line {lineno}: {reason}", file=sys.stderr)
            continue
        except ValueError as error:
            if not permissive:
                raise ValueError(f"{path} line {lineno}: {error}") from error
            print(f"skipping line {lineno}: {error}", file=sys.stderr)
            continue

        questions.append(question)

    if permissive and not questions:
        raise ValueError(f"{path}: no valid rows remained after permissive validation")

    return questions
