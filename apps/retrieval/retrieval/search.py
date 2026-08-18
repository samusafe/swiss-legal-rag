import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from retrieval.db import ChunkRow
from retrieval.fusion import rrf
from retrieval.models import SearchResponse, SearchResult

# Sized from a real miss: for "Brauche ich eine Baubewilligung für ein
# Gartenhaus im Kanton Bern?" the governing article (BSG 721.0 Art. 1a) sat
# at dense rank 24 — a 20-candidate pool never showed it to the reranker.
# The reranker is the cost driver (CPU cross-encoder, linear in pool size);
# 40 keeps it bounded while covering near-miss ranks.
CANDIDATES = 40

CacheKey = tuple[str, int, str | None, str | None]

_WORD_RE = re.compile(r"[^\W\d_]{3,}", re.UNICODE)


def fts_query(q: str) -> str:
    """Rewrite a natural-language question into an OR-of-terms websearch query.

    websearch_to_tsquery ANDs plain terms, so one out-of-corpus word (e.g.
    "Gartenhaus") empties the whole FTS arm for an otherwise well-covered
    question. OR keeps every term contributing; ts_rank_cd still ranks
    multi-term matches first. Words under 3 letters are dropped (stopword
    noise); an all-short query falls through unchanged.
    """
    words = _WORD_RE.findall(q)
    return " or ".join(words) if words else q


class SearchCache:
    """LRU for run_search responses, keyed by (q, k, lang, canton).

    Embed + rerank dominate search latency on CPU, and the corpus only
    changes via an ingest run — so entries stay valid until the app clears
    the cache on ingest start. Thread-safe: sync endpoints run concurrently
    in Starlette's threadpool.
    """

    def __init__(self, maxsize: int = 128) -> None:
        self._maxsize = maxsize
        self._lock = threading.Lock()
        self._entries: OrderedDict[CacheKey, SearchResponse] = OrderedDict()

    def get(self, key: CacheKey) -> SearchResponse | None:
        with self._lock:
            response = self._entries.get(key)
            if response is not None:
                self._entries.move_to_end(key)
            return response

    def put(self, key: CacheKey, response: SearchResponse) -> None:
        with self._lock:
            self._entries[key] = response
            while len(self._entries) > self._maxsize:
                self._entries.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


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
    fts_rows = deps.fts(fts_query(q), lang, CANDIDATES, jurisdictions) if lang is not None else []
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
