from datetime import date

from retrieval.db import ChunkRow
from retrieval.search import SearchDeps, fts_query, run_search


def row(id_: int, text: str) -> ChunkRow:
    return ChunkRow(
        id=id_, jurisdiction="CH", collection="SR", number="220", lang="de",
        article=str(id_), part=None, eid=f"art_{id_}",
        heading=None, context=None, text=text,
        source_url=f"https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_{id_}",
        act_name="Code of Obligations", abbrev="OR / CO", version_date=date(2026, 1, 1),
    )


A, B, C = row(1, "alpha"), row(2, "beta"), row(3, "gamma")
SCORES = {"alpha": 0.1, "beta": 0.5, "gamma": 0.9}


def deps_with(fts_langs: list[str]) -> SearchDeps:
    return SearchDeps(
        embed=lambda q: [0.0] * 1024,
        dense=lambda vector, k, jur: [A, B],
        fts=lambda q, lang, k, jur: (fts_langs.append(lang), [B, C])[1],
        rerank=lambda q, texts: [SCORES[t] for t in texts],
    )


def test_fts_query_ors_terms_and_drops_short_words() -> None:
    # websearch_to_tsquery ANDs plain terms, so one out-of-corpus word
    # ("Gartenhaus") would empty the whole FTS arm without the OR rewrite.
    q = "Brauche ich eine Baubewilligung für ein Gartenhaus im Kanton Bern?"
    assert fts_query(q) == (
        "Brauche or ich or eine or Baubewilligung or für or ein or Gartenhaus or Kanton or Bern"
    )


def test_fts_query_leaves_an_all_short_query_unchanged() -> None:
    assert fts_query("OR 12") == "OR 12"


def test_run_search_passes_the_or_rewritten_query_to_fts() -> None:
    seen: list[str] = []
    deps = SearchDeps(
        embed=lambda q: [0.0] * 1024,
        dense=lambda vector, k, jur: [A],
        fts=lambda q, lang, k, jur: (seen.append(q), [B])[1],
        rerank=lambda q, texts: [SCORES[t] for t in texts],
    )
    run_search(deps, "Baubewilligung für Gartenhaus", 5, "de")
    assert seen == ["Baubewilligung or für or Gartenhaus"]


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
        dense=lambda vector, k, jur: [],
        fts=lambda q, lang, k, jur: [],
        rerank=exploding_rerank,
    )
    response = run_search(deps, "frage", 5, "de")
    assert response.results == []
    assert set(response.took_ms) == {"embed", "search", "rerank"}


def test_run_search_skips_fts_when_lang_is_none() -> None:
    def exploding_fts(q: str, lang: str, k: int, jur: list[str]) -> list[ChunkRow]:
        raise AssertionError("fts must not be called when lang is None")

    deps = SearchDeps(
        embed=lambda q: [0.0] * 1024,
        dense=lambda vector, k, jur: [A, B],
        fts=exploding_fts,
        rerank=lambda q, texts: [SCORES[t] for t in texts],
    )
    response = run_search(deps, "frage", 5, None)
    assert [r.article for r in response.results] == ["2", "1"]


def test_search_passes_jurisdictions() -> None:
    seen: list[list[str]] = []
    deps = SearchDeps(
        embed=lambda q: [0.0],
        dense=lambda v, k, jur: (seen.append(jur), [A])[1],
        fts=lambda q, lang, k, jur: (seen.append(jur), [])[1],
        rerank=lambda q, texts: [1.0] * len(texts),
    )
    run_search(deps, "kündigungsfrist", k=5, lang="de", canton="SG")
    assert seen == [["CH", "SG"], ["CH", "SG"]]


def test_search_defaults_to_federal_only() -> None:
    seen: list[list[str]] = []
    deps = SearchDeps(
        embed=lambda q: [0.0],
        dense=lambda v, k, jur: (seen.append(jur), [A])[1],
        fts=lambda q, lang, k, jur: (seen.append(jur), [])[1],
        rerank=lambda q, texts: [1.0] * len(texts),
    )
    run_search(deps, "x", k=5, lang="de", canton=None)
    assert seen[0] == ["CH"]
