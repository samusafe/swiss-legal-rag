import re

from pydantic import BaseModel

from retrieval.models import SearchResult

# A bracket may carry several comma/semicolon-separated references:
# "[SR 822.11 Art. 9, SR 822.11 Art. 12]". Match whole brackets first,
# then each reference inside; brackets with no citation reference are prose.
# The collection token is broader than the old "SR"-only match (federal AND
# cantonal collections, e.g. "sGS"); resolution against real sources is the
# safety net — an unresolved ref just renders as an unlinked label.
_BRACKET_RE = re.compile(r"\[([^\]]+)\]")
_REF_RE = re.compile(r"\b([A-Za-z][A-Za-z/]{0,9})\s+([\d.]+)\s+Art\.\s*([\w.]+)")


class Citation(BaseModel):
    raw: str
    label: str
    collection: str
    number: str
    article: str
    source_url: str | None
    resolved: bool


def _resolve_by_key(
    sources: list[SearchResult], answer_lang: str | None
) -> dict[tuple[str, str, str], SearchResult]:
    """One source per (collection, number, article). Cross-lingual dense retrieval
    can return the same article in two languages; prefer the one matching the
    answer language, else the best-scored candidate — never an arbitrary/
    nondeterministic pick."""
    groups: dict[tuple[str, str, str], list[SearchResult]] = {}
    for source in sources:
        key = (source.collection, source.number, source.article.lower())
        groups.setdefault(key, []).append(source)
    resolved: dict[tuple[str, str, str], SearchResult] = {}
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
    seen_raws: set[str] = set()
    for bracket in _BRACKET_RE.finditer(answer):
        raw = bracket.group(0)
        if raw in seen_raws:
            continue
        emitted: set[tuple[str, str, str]] = set()
        for ref in _REF_RE.finditer(bracket.group(1)):
            collection, number, article = ref.group(1), ref.group(2), ref.group(3)
            key = (collection, number, article.lower())
            if key in emitted:
                continue
            emitted.add(key)
            source = by_key.get(key)
            citations.append(
                Citation(
                    raw=raw,
                    label=f"{collection} {number} Art. {article}",
                    collection=collection,
                    number=number,
                    article=article,
                    source_url=source.source_url if source is not None else None,
                    resolved=source is not None,
                )
            )
        if emitted:
            seen_raws.add(raw)
    return citations
