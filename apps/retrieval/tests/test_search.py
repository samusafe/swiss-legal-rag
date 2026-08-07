from datetime import date

from retrieval.db import ChunkRow
from retrieval.search import SearchDeps, run_search


def row(id_: int, text: str) -> ChunkRow:
    return ChunkRow(
        id=id_, sr="220", lang="de", article=str(id_), part=None, eid=f"art_{id_}",
        heading=None, context=None, text=text,
        eli=f"https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_{id_}",
        act_name="Code of Obligations", abbrev="OR / CO", version_date=date(2026, 1, 1),
    )


A, B, C = row(1, "alpha"), row(2, "beta"), row(3, "gamma")
SCORES = {"alpha": 0.1, "beta": 0.5, "gamma": 0.9}


def deps_with(fts_langs: list[str]) -> SearchDeps:
    return SearchDeps(
        embed=lambda q: [0.0] * 1024,
        dense=lambda vector, k: [A, B],
        fts=lambda q, lang, k: (fts_langs.append(lang), [B, C])[1],
        rerank=lambda q, texts: [SCORES[t] for t in texts],
    )


def test_run_search_orders_by_rerank_score() -> None:
    langs: list[str] = []
    response = run_search(deps_with(langs), "frage", 5, "de")
    assert [r.article for r in response.results] == ["3", "2", "1"]
    assert response.results[0].score == 0.9
    assert langs == ["de"]
    assert set(response.took_ms) == {"embed", "search", "rerank"}


def test_run_search_truncates_to_k() -> None:
    response = run_search(deps_with([]), "frage", 2, "de")
    assert len(response.results) == 2


def test_run_search_returns_empty_when_no_candidates() -> None:
    def exploding_rerank(q: str, texts: list[str]) -> list[float]:
        raise AssertionError("rerank must not be called with no candidates")

    deps = SearchDeps(
        embed=lambda q: [0.0] * 1024,
        dense=lambda vector, k: [],
        fts=lambda q, lang, k: [],
        rerank=exploding_rerank,
    )
    response = run_search(deps, "frage", 5, "de")
    assert response.results == []
    assert set(response.took_ms) == {"embed", "search", "rerank"}


def test_run_search_skips_fts_when_lang_is_none() -> None:
    def exploding_fts(q: str, lang: str, k: int) -> list[ChunkRow]:
        raise AssertionError("fts must not be called when lang is None")

    deps = SearchDeps(
        embed=lambda q: [0.0] * 1024,
        dense=lambda vector, k: [A, B],
        fts=exploding_fts,
        rerank=lambda q, texts: [SCORES[t] for t in texts],
    )
    response = run_search(deps, "frage", 5, None)
    assert [r.article for r in response.results] == ["2", "1"]
