import time
from collections.abc import Callable
from dataclasses import dataclass

from retrieval.db import ChunkRow
from retrieval.fusion import rrf
from retrieval.models import SearchResponse, SearchResult

CANDIDATES = 20


@dataclass(frozen=True)
class SearchDeps:
    embed: Callable[[str], list[float]]
    dense: Callable[[list[float], int, list[str]], list[ChunkRow]]
    fts: Callable[[str, str, int, list[str]], list[ChunkRow]]
    rerank: Callable[[str, list[str]], list[float]]


def run_search(
    deps: SearchDeps, q: str, k: int, lang: str | None, canton: str | None = None
) -> SearchResponse:
    # lang=None skips the FTS arm entirely (dense + rerank only) — used by /chat
    # when the detected question language isn't one FTS has a config for.
    # Federal law (CH) is always in scope; a canton adds its cantonal corpus on top.
    jurisdictions = ["CH"] + ([canton] if canton else [])
    t0 = time.perf_counter()
    query_vector = deps.embed(q)
    t1 = time.perf_counter()
    dense_rows = deps.dense(query_vector, CANDIDATES, jurisdictions)
    fts_rows = deps.fts(q, lang, CANDIDATES, jurisdictions) if lang is not None else []
    by_id = {row.id: row for row in [*dense_rows, *fts_rows]}
    fused_ids = rrf([[r.id for r in dense_rows], [r.id for r in fts_rows]])[:CANDIDATES]
    candidates = [by_id[i] for i in fused_ids]
    t2 = time.perf_counter()
    if not candidates:
        # CrossEncoder.predict([]) raises in sentence-transformers 3.x — and there is
        # nothing to rank anyway.
        return SearchResponse(
            results=[],
            took_ms={
                "embed": int((t1 - t0) * 1000),
                "search": int((t2 - t1) * 1000),
                "rerank": 0,
            },
        )
    scores = deps.rerank(q, [row.text for row in candidates])
    ranked = sorted(zip(candidates, scores), key=lambda pair: -pair[1])[:k]
    t3 = time.perf_counter()
    results = [
        SearchResult(**row.model_dump(exclude={"id"}), score=score) for row, score in ranked
    ]
    return SearchResponse(
        results=results,
        took_ms={
            "embed": int((t1 - t0) * 1000),
            "search": int((t2 - t1) * 1000),
            "rerank": int((t3 - t2) * 1000),
        },
    )
