from datetime import date

from retrieval.citations import extract_citations
from retrieval.models import SearchResult


def _source(sr: str, article: str) -> SearchResult:
    return SearchResult(
        sr=sr, lang="de", article=article, part=None, eid=f"art_{article}",
        heading=None, context=None, text="body",
        eli=f"https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_{article}",
        act_name="Code of Obligations", abbrev="OR", version_date=date(2026, 1, 1),
        score=0.9,
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
