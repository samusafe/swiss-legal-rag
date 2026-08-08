"""Deterministic scoring functions for retrieval/chat eval rows.

All "empty expected" / "nothing scored" cases return `None` rather than 0.0
so a row's absence of a signal never silently drags a mean down.
"""

from __future__ import annotations

import re
import statistics
from collections.abc import Sequence

_SOURCE_RE = re.compile(r"^SR\s+(\S+)\s+Art\.\s+(\S+)$", re.IGNORECASE)

# Must match retrieval/generation.py's REFUSAL_SENTENCE verbatim (apps/evals has no
# dependency on apps/retrieval — the two packages talk over HTTP, so the sentence is
# duplicated here as the evals side's single source of truth for the contract).
REFUSAL_SENTENCE = "The current corpus contains no sources sufficient to answer this question."


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


def _normalize_for_refusal_match(text: str) -> str:
    """Casefold + collapse all whitespace runs to a single space + strip."""
    return re.sub(r"\s+", " ", text).strip().casefold()


def refusal_ok(citations: list[dict], must_refuse: bool, answer: str) -> bool | None:
    """True only when nothing resolved AND the whole answer equals the canonical
    refusal sentence after normalization (casefold + whitespace-collapse) — zero
    citations alone no longer counts as a refusal, since a model can drop
    citations without actually declining to answer, and a sentence merely
    containing the canonical text (e.g. with extra hedging words) no longer
    counts either, matching the upstream harness's exact-match contract."""
    if not must_refuse:
        return None
    nothing_resolved = not any(c.get("resolved") for c in citations)
    return nothing_resolved and (
        _normalize_for_refusal_match(answer) == _normalize_for_refusal_match(REFUSAL_SENTENCE)
    )


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
