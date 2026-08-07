from datetime import date

from retrieval.citations import extract_citations
from retrieval.models import SearchResult


def _source(sr: str, article: str, lang: str = "de", score: float = 0.9) -> SearchResult:
    return SearchResult(
        sr=sr, lang=lang, article=article, part=None, eid=f"art_{article}",
        heading=None, context=None, text="body",
        eli=f"https://www.fedlex.admin.ch/eli/cc/27/317_321_377/{lang}#art_{article}",
        act_name="Code of Obligations", abbrev="OR", version_date=date(2026, 1, 1),
        score=score,
    )


def test_extracts_and_resolves_citation() -> None:
    sources = [_source("220", "335c")]
    citations = extract_citations("Die Frist beträgt einen Monat [SR 220 Art. 335c].", sources)
    assert len(citations) == 1
    c = citations[0]
    assert (c.raw, c.sr, c.article, c.resolved) == ("[SR 220 Art. 335c]", "220", "335c", True)
    assert c.eli == sources[0].eli


def test_unknown_citation_is_unresolved() -> None:
    citations = extract_citations("Siehe [SR 999 Art. 1].", [_source("220", "1")])
    assert citations[0].resolved is False
    assert citations[0].eli is None


def test_duplicate_citations_collapse_and_order_is_first_appearance() -> None:
    sources = [_source("220", "1"), _source("220", "2")]
    answer = "A [SR 220 Art. 2]. B [SR 220 Art. 1]. C [SR 220 Art. 2]."
    citations = extract_citations(answer, sources)
    assert [c.article for c in citations] == ["2", "1"]


def test_article_match_is_case_insensitive() -> None:
    citations = extract_citations("[SR 220 Art. 335C]", [_source("220", "335c")])
    assert citations[0].resolved is True


def test_refusal_answer_has_no_citations() -> None:
    assert extract_citations("Ich kann diese Frage nicht beantworten.", []) == []


def test_dotted_sr_number_resolves() -> None:
    citations = extract_citations("[SR 142.20 Art. 5]", [_source("142.20", "5")])
    assert citations[0].resolved is True


def test_letter_suffixed_article_resolves() -> None:
    citations = extract_citations("[SR 220 Art. 219a]", [_source("220", "219a")])
    assert citations[0].resolved is True


def test_citation_resolves_to_source_matching_answer_language() -> None:
    de = _source("220", "1", lang="de", score=0.5)
    fr = _source("220", "1", lang="fr", score=0.2)
    citations = extract_citations("[SR 220 Art. 1]", [de, fr], answer_lang="fr")
    assert citations[0].eli == fr.eli


def test_citation_falls_back_to_best_scored_when_no_lang_match() -> None:
    de = _source("220", "1", lang="de", score=0.5)
    fr = _source("220", "1", lang="fr", score=0.2)
    citations = extract_citations("[SR 220 Art. 1]", [de, fr], answer_lang="it")
    assert citations[0].eli == de.eli


def test_citation_falls_back_to_best_scored_when_answer_lang_unknown() -> None:
    low = _source("220", "1", lang="de", score=0.1)
    high = _source("220", "1", lang="fr", score=0.7)
    citations = extract_citations("[SR 220 Art. 1]", [low, high])
    assert citations[0].eli == high.eli
