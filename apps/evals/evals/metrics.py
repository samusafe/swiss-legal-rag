"""Deterministic scoring functions for retrieval/chat eval rows.

All "empty expected" / "nothing scored" cases return `None` rather than 0.0
so a row's absence of a signal never silently drags a mean down.
"""

from __future__ import annotations

import re
import statistics
from collections.abc import Sequence

_SOURCE_RE = re.compile(r"^SR\s+(\S+)\s+Art\.\s+(\S+)$", re.IGNORECASE)


def _parse_source(source: str) -> tuple[str, str]:
    match = _SOURCE_RE.match(source.strip())
    if not match:
        raise ValueError(f"unparseable source reference: {source!r}")
    sr, article = match.groups()
    return sr, article.lower()


def retrieval_hit(results: list[dict], expected_sources: Sequence[str]) -> bool | None:
    if not expected_sources:
        return None
    candidates = {f"SR {r['sr']} Art. {r['article']}".casefold() for r in results}
    return any(source.casefold() in candidates for source in expected_sources)


def citation_scores(
    citations: list[dict], expected_sources: Sequence[str]
) -> tuple[float | None, float | None]:
    cited = {
        (c["sr"], c["article"].lower()) for c in citations if c.get("resolved")
    }
    expected = {_parse_source(source) for source in expected_sources}

    overlap = len(cited & expected)
    precision = overlap / len(cited) if cited else None
    recall = overlap / len(expected) if expected else None
    return precision, recall


def keyword_recall(answer: str, keywords: Sequence[str]) -> float | None:
    if not keywords:
        return None
    answer_cf = answer.casefold()
    hits = sum(1 for keyword in keywords if keyword.casefold() in answer_cf)
    return hits / len(keywords)


def refusal_ok(citations: list[dict], must_refuse: bool) -> bool | None:
    if not must_refuse:
        return None
    return not any(c.get("resolved") for c in citations)


_MEAN_METRICS = {
    "hit": "hit_rate",
    "citation_precision": "citation_precision",
    "citation_recall": "citation_recall",
    "keyword_recall": "keyword_recall",
    "refusal_ok": "refusal_accuracy",
}


def summarize(rows: list[dict]) -> dict:
    summary: dict = {}
    for row_key, summary_key in _MEAN_METRICS.items():
        values = [row[row_key] for row in rows if row.get(row_key) is not None]
        summary[summary_key] = (sum(values) / len(values)) if values else None

    latencies = [row["latency_s"] for row in rows if row.get("latency_s") is not None]
    summary["median_latency_s"] = statistics.median(latencies) if latencies else 0.0
    summary["questions"] = len(rows)
    summary["errors"] = sum(1 for row in rows if row.get("error") is not None)
    return summary
