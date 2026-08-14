from datetime import date

from retrieval.citations import extract_citations
from retrieval.models import SearchResult


def make_source(
    collection: str = "SR",
    number: str = "220",
    article: str = "1",
    lang: str = "de",
    score: float = 0.9,
) -> SearchResult:
    return SearchResult(
        jurisdiction="CH" if collection == "SR" else "SG",
        collection=collection, number=number, lang=lang, article=article, part=None,
        eid=f"art_{article}", heading=None, context=None, text="body",
        source_url=f"https://www.fedlex.admin.ch/eli/cc/27/317_321_377/{lang}#art_{article}",
        act_name="Code of Obligations", abbrev="OR", version_date=date(2026, 1, 1),
        score=score,
    )


def test_extracts_and_resolves_citation() -> None:
    sources = [make_source(number="220", article="335c")]
    citations = extract_citations("Die Frist beträgt einen Monat [SR 220 Art. 335c].", sources)
    assert len(citations) == 1
    c = citations[0]
    assert (c.raw, c.collection, c.number, c.article, c.resolved) == (
        "[SR 220 Art. 335c]", "SR", "220", "335c", True,
    )
    assert c.source_url == sources[0].source_url


def test_unknown_citation_is_unresolved() -> None:
    citations = extract_citations("Siehe [SR 999 Art. 1].", [make_source(number="220", article="1")])
    assert citations[0].resolved is False
    assert citations[0].source_url is None


def test_duplicate_citations_collapse_and_order_is_first_appearance() -> None:
    sources = [make_source(number="220", article="1"), make_source(number="220", article="2")]
    answer = "A [SR 220 Art. 2]. B [SR 220 Art. 1]. C [SR 220 Art. 2]."
    citations = extract_citations(answer, sources)
    assert [c.article for c in citations] == ["2", "1"]


def test_article_match_is_case_insensitive() -> None:
    citations = extract_citations(
        "[SR 220 Art. 335C]", [make_source(number="220", article="335c")]
    )
    assert citations[0].resolved is True


def test_refusal_answer_has_no_citations() -> None:
    assert extract_citations("Ich kann diese Frage nicht beantworten.", []) == []


def test_dotted_sr_number_resolves() -> None:
    citations = extract_citations("[SR 142.20 Art. 5]", [make_source(number="142.20", article="5")])
    assert citations[0].resolved is True


def test_letter_suffixed_article_resolves() -> None:
    citations = extract_citations("[SR 220 Art. 219a]", [make_source(number="220", article="219a")])
    assert citations[0].resolved is True


def test_citation_resolves_to_source_matching_answer_language() -> None:
    de = make_source(number="220", article="1", lang="de", score=0.5)
    fr = make_source(number="220", article="1", lang="fr", score=0.2)
    citations = extract_citations("[SR 220 Art. 1]", [de, fr], answer_lang="fr")
    assert citations[0].source_url == fr.source_url


def test_citation_falls_back_to_best_scored_when_no_lang_match() -> None:
    de = make_source(number="220", article="1", lang="de", score=0.5)
    fr = make_source(number="220", article="1", lang="fr", score=0.2)
    citations = extract_citations("[SR 220 Art. 1]", [de, fr], answer_lang="it")
    assert citations[0].source_url == de.source_url


def test_citation_falls_back_to_best_scored_when_answer_lang_unknown() -> None:
    low = make_source(number="220", article="1", lang="de", score=0.1)
    high = make_source(number="220", article="1", lang="fr", score=0.7)
    citations = extract_citations("[SR 220 Art. 1]", [low, high])
    assert citations[0].source_url == high.source_url


def test_multi_ref_bracket_yields_one_citation_per_ref() -> None:
    sources = [
        make_source(number="822.11", article="9", lang="fr", score=0.9),
        make_source(number="822.11", article="12", lang="fr", score=0.8),
    ]
    answer = "Max 45 hours [SR 822.11 Art. 9, SR 822.11 Art. 12]."
    citations = extract_citations(answer, sources, "fr")
    assert [c.label for c in citations] == ["SR 822.11 Art. 9", "SR 822.11 Art. 12"]
    assert all(c.raw == "[SR 822.11 Art. 9, SR 822.11 Art. 12]" for c in citations)
    assert all(c.resolved for c in citations)


def test_multi_ref_bracket_mixed_resolution() -> None:
    sources = [make_source(number="822.11", article="9", lang="fr", score=0.9)]
    answer = "See [SR 822.11 Art. 9, SR 999 Art. 1]."
    citations = extract_citations(answer, sources, "fr")
    assert citations[0].resolved and citations[0].source_url is not None
    assert not citations[1].resolved and citations[1].source_url is None


def test_single_ref_bracket_unchanged() -> None:
    sources = [make_source(number="220", article="335b", lang="fr", score=0.9)]
    citations = extract_citations("See [SR 220 Art. 335b].", sources, "fr")
    assert len(citations) == 1
    assert citations[0].raw == "[SR 220 Art. 335b]"
    assert citations[0].label == "SR 220 Art. 335b"


def test_bracket_without_sr_reference_ignored() -> None:
    assert extract_citations("A note [see above] here.", [], None) == []


def test_repeated_bracket_deduplicated() -> None:
    answer = "[SR 220 Art. 1] and again [SR 220 Art. 1]."
    citations = extract_citations(answer, [], None)
    assert len(citations) == 1


def test_duplicate_ref_within_bracket_deduplicated() -> None:
    citations = extract_citations("[SR 220 Art. 1, SR 220 Art. 1]", [], None)
    assert len(citations) == 1


def test_extracts_cantonal_citation() -> None:
    sources = [make_source(collection="sGS", number="811.1", article="2")]
    cits = extract_citations("Steuern regelt [sGS 811.1 Art. 2].", sources)
    assert cits[0].resolved and cits[0].collection == "sGS"
    assert cits[0].label == "sGS 811.1 Art. 2"


def test_federal_citation_still_resolves() -> None:
    sources = [make_source(collection="SR", number="220", article="335c")]
    cits = extract_citations("Frist: [SR 220 Art. 335c].", sources)
    assert cits[0].resolved and cits[0].source_url == sources[0].source_url


def test_broad_ref_regex_does_not_match_inside_a_longer_leading_word() -> None:
    # "\b" only anchors the left edge — a bracket with a leading prose word
    # ("siehe") followed by a real reference must still yield exactly one
    # citation, not two (and not a spurious match on "siehe" itself).
    sources = [make_source(collection="sGS", number="811.1", article="2")]
    cits = extract_citations("[siehe sGS 811.1 Art. 2]", sources)
    assert len(cits) == 1
    assert cits[0].resolved and cits[0].collection == "sGS"
