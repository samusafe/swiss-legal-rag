"""Gold-question dataset loader.

Dataset format: one JSON object per line (`.jsonl`); blank lines and lines
starting with `//` are comments and are skipped.
"""

from __future__ import annotations

import json
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


@dataclass(frozen=True)
class GoldQuestion:
    id: str
    lang: str
    question: str
    expected_sources: tuple[str, ...]
    expected_keywords: tuple[str, ...]
    must_refuse: bool


def load_gold(path: Path) -> list[GoldQuestion]:
    questions: list[GoldQuestion] = []
    lines = path.read_text(encoding="utf-8").splitlines()
    for lineno, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("//"):
            continue

        try:
            data = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path} line {lineno}: invalid JSON ({error})") from error

        for field in _REQUIRED_FIELDS:
            if field not in data:
                raise ValueError(f"{path} line {lineno}: missing field {field!r}")

        lang = data["lang"]
        if lang not in _VALID_LANGS:
            raise ValueError(
                f"{path} line {lineno}: lang must be one of "
                f"{sorted(_VALID_LANGS)}, got {lang!r}"
            )

        for list_field in ("expected_sources", "expected_keywords"):
            value = data[list_field]
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                raise ValueError(
                    f"{path} line {lineno}: {list_field!r} must be a list of strings, "
                    f"got {value!r}"
                )

        must_refuse = data["must_refuse"]
        if not isinstance(must_refuse, bool):
            raise ValueError(
                f"{path} line {lineno}: 'must_refuse' must be a bool, got {must_refuse!r}"
            )

        for source in data["expected_sources"]:
            if not _SOURCE_RE.match(source.strip()):
                raise ValueError(
                    f"{path} line {lineno}: expected_sources entry {source!r} must match "
                    f'"SR <nr> Art. <x>"'
                )

        questions.append(
            GoldQuestion(
                id=data["id"],
                lang=lang,
                question=data["question"],
                expected_sources=tuple(data["expected_sources"]),
                expected_keywords=tuple(data["expected_keywords"]),
                must_refuse=must_refuse,
            )
        )
    return questions
