import re

from pydantic import BaseModel

from retrieval.models import SearchResult

_CITATION_RE = re.compile(r"\[SR\s+([\d.]+)\s+Art\.\s*([\w.]+)\]")


class Citation(BaseModel):
    raw: str
    sr: str
    article: str
    eli: str | None
    resolved: bool


def _resolve_by_key(
    sources: list[SearchResult], answer_lang: str | None
) -> dict[tuple[str, str], SearchResult]:
    """One source per (sr, article). Cross-lingual dense retrieval can return the
    same article in two languages; prefer the one matching the answer language,
    else the best-scored candidate — never an arbitrary/nondeterministic pick."""
    groups: dict[tuple[str, str], list[SearchResult]] = {}
    for source in sources:
        groups.setdefault((source.sr, source.article.lower()), []).append(source)
    resolved: dict[tuple[str, str], SearchResult] = {}
    for key, group in groups.items():
        matching = [s for s in group if answer_lang is not None and s.lang == answer_lang]
        pool = matching if matching else group
        resolved[key] = max(pool, key=lambda s: s.score)
    return resolved


def extract_citations(
    answer: str, sources: list[SearchResult], answer_lang: str | None = None
) -> list[Citation]:
    by_key = _resolve_by_key(sources, answer_lang)
    citations: list[Citation] = []
    seen: set[str] = set()
    for match in _CITATION_RE.finditer(answer):
        raw = match.group(0)
        if raw in seen:
            continue
        seen.add(raw)
        sr, article = match.group(1), match.group(2)
        source = by_key.get((sr, article.lower()))
        citations.append(
            Citation(
                raw=raw,
                sr=sr,
                article=article,
                eli=source.eli if source is not None else None,
                resolved=source is not None,
            )
        )
    return citations
