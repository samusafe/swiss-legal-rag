import pytest

from evals.metrics import (
    _SOURCE_RE,
    citation_scores,
    keyword_recall,
    refusal_ok,
    retrieval_hit,
    summarize,
)


def test_source_re_accepts_cantonal() -> None:
    assert _SOURCE_RE.match("sGS 811.1 Art. 2")
    assert _SOURCE_RE.match("BSG 721.0 Art. 4")
    assert _SOURCE_RE.match("SR 220 Art. 335c")


def test_retrieval_hit_true_when_expected_source_present():
    results = [
        {"collection": "SR", "number": "220", "article": "1"},
        {"collection": "SR", "number": "210", "article": "2"},
    ]
    assert retrieval_hit(results, ["SR 220 Art. 1"]) is True


def test_retrieval_hit_cantonal() -> None:
    results = [{"collection": "sGS", "number": "811.1", "article": "2"}]
    assert retrieval_hit(results, ("sGS 811.1 Art. 2",))


def test_retrieval_hit_false_when_no_result_matches():
    results = [{"collection": "SR", "number": "220", "article": "1"}]
    assert retrieval_hit(results, ["SR 999 Art. 9"]) is False


def test_retrieval_hit_none_when_expected_sources_empty():
    assert retrieval_hit([{"collection": "SR", "number": "220", "article": "1"}], []) is None


def test_retrieval_hit_is_case_insensitive():
    results = [{"collection": "SR", "number": "220", "article": "1"}]
    assert retrieval_hit(results, ["sr 220 art. 1"]) is True


def test_citation_scores_precision_and_recall():
    citations = [
        {"collection": "SR", "number": "220", "article": "1", "resolved": True},
        {"collection": "SR", "number": "210", "article": "2", "resolved": True},
    ]
    precision, recall = citation_scores(citations, ["SR 220 Art. 1"])
    assert precision == 0.5
    assert recall == 1.0


def test_citation_scores_excludes_unresolved_citations():
    citations = [
        {"collection": "SR", "number": "220", "article": "1", "resolved": False},
        {"collection": "SR", "number": "210", "article": "2", "resolved": True},
    ]
    precision, recall = citation_scores(citations, ["SR 220 Art. 1"])
    assert precision == 0.0
    assert recall == 0.0


def test_citation_scores_empty_cited_gives_none_precision_but_real_recall():
    precision, recall = citation_scores([], ["SR 220 Art. 1"])
    assert precision is None
    assert recall == 0.0


def test_citation_scores_empty_expected_gives_real_precision_but_none_recall():
    citations = [{"collection": "SR", "number": "220", "article": "1", "resolved": True}]
    precision, recall = citation_scores(citations, [])
    assert precision == 0.0
    assert recall is None


def test_citation_scores_matches_case_insensitively_on_article():
    citations = [{"collection": "SR", "number": "220", "article": "1A", "resolved": True}]
    precision, recall = citation_scores(citations, ["SR 220 Art. 1a"])
    assert precision == 1.0
    assert recall == 1.0


def test_citation_scores_matches_cantonal_collection():
    citations = [{"collection": "sGS", "number": "811.1", "article": "2", "resolved": True}]
    precision, recall = citation_scores(citations, ["sGS 811.1 Art. 2"])
    assert precision == 1.0
    assert recall == 1.0


def test_citation_scores_collection_case_insensitive():
    # Gold source uppercase, citation dict mixed case — must match case-insensitively
    citations = [{"collection": "sGS", "number": "811.1", "article": "2", "resolved": True}]
    precision, recall = citation_scores(citations, ["SGS 811.1 Art. 2"])
    assert precision == 1.0
    assert recall == 1.0


def test_citation_scores_raises_on_unparseable_expected_source():
    with pytest.raises(ValueError):
        citation_scores([], ["not a source reference"])


def test_keyword_recall_casefold_substring_match():
    assert keyword_recall(
        "Der Vertrag ist gültig", ["vertrag", "GÜLTIG", "missing"]
    ) == pytest.approx(2 / 3)


def test_keyword_recall_none_when_no_expected_keywords():
    assert keyword_recall("irrelevant answer text", []) is None


def test_refusal_ok_true_when_nothing_resolved_and_canonical_sentence_present():
    answer = "The current corpus contains no sources sufficient to answer this question."
    assert refusal_ok([{"resolved": False}], True, answer) is True


def test_refusal_ok_false_when_must_refuse_but_something_resolved():
    answer = "The current corpus contains no sources sufficient to answer this question."
    assert refusal_ok([{"resolved": True}, {"resolved": False}], True, answer) is False


def test_refusal_ok_false_when_nothing_resolved_but_canonical_sentence_missing():
    assert refusal_ok([{"resolved": False}], True, "Ich kann das nicht beantworten") is False


def test_refusal_ok_is_case_insensitive_on_canonical_sentence():
    answer = "THE CURRENT CORPUS CONTAINS NO SOURCES SUFFICIENT TO ANSWER THIS QUESTION."
    assert refusal_ok([{"resolved": False}], True, answer) is True


def test_refusal_ok_none_when_not_must_refuse():
    assert refusal_ok([{"resolved": True}], False, "irrelevant") is None


def test_refusal_ok_false_when_extra_trailing_words_added():
    # Upstream contract: the whole answer must equal the canonical sentence,
    # not merely contain it -- added words must fail even though the sentence
    # is present verbatim as a substring.
    answer = (
        "The current corpus contains no sources sufficient to answer this "
        "question. Please consult a lawyer."
    )
    assert refusal_ok([{"resolved": False}], True, answer) is False


def test_refusal_ok_false_when_extra_leading_words_added():
    answer = (
        "I'm sorry. The current corpus contains no sources sufficient to "
        "answer this question."
    )
    assert refusal_ok([{"resolved": False}], True, answer) is False


def test_refusal_ok_true_with_whitespace_run_collapsed():
    answer = "The current   corpus contains no sources\nsufficient to answer this question."
    assert refusal_ok([{"resolved": False}], True, answer) is True


def test_refusal_ok_true_with_surrounding_whitespace_stripped():
    answer = "  \n The current corpus contains no sources sufficient to answer this question. \n "
    assert refusal_ok([{"resolved": False}], True, answer) is True


def test_refusal_ok_true_with_case_and_whitespace_variant_combined():
    answer = "  THE current   CORPUS contains no sources sufficient to answer this question.  "
    assert refusal_ok([{"resolved": False}], True, answer) is True


def test_summarize_computes_means_over_non_null_rows():
    rows = [
        {
            "hit": True,
            "citation_precision": 1.0,
            "citation_recall": None,
            "keyword_recall": 0.5,
            "refusal_ok": None,
            "latency_s": 1.0,
            "error": None,
        },
        {
            "hit": False,
            "citation_precision": None,
            "citation_recall": 0.5,
            "keyword_recall": None,
            "refusal_ok": True,
            "latency_s": 3.0,
            "error": None,
        },
        {
            "hit": None,
            "citation_precision": None,
            "citation_recall": None,
            "keyword_recall": None,
            "refusal_ok": None,
            "latency_s": 2.0,
            "error": "boom",
        },
    ]

    summary = summarize(rows)

    assert summary == {
        "hit_rate": 0.5,
        "citation_precision": 1.0,
        "citation_recall": 0.5,
        "keyword_recall": 0.5,
        "refusal_accuracy": 1.0,
        "median_latency_s": 2.0,
        "questions": 3,
        "errors": 1,
    }


def test_summarize_all_null_metric_yields_null_summary_value():
    rows = [
        {
            "hit": None,
            "citation_precision": None,
            "citation_recall": None,
            "keyword_recall": None,
            "refusal_ok": None,
            "latency_s": 1.0,
            "error": None,
        }
    ]

    summary = summarize(rows)

    assert summary["hit_rate"] is None
    assert summary["citation_precision"] is None
    assert summary["citation_recall"] is None
    assert summary["keyword_recall"] is None
    assert summary["refusal_accuracy"] is None
    assert summary["errors"] == 0
