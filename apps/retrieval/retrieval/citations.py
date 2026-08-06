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


def extract_citations(answer: str, sources: list[SearchResult]) -> list[Citation]:
    by_key = {(s.sr, s.article.lower()): s for s in sources}
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
