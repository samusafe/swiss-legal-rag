from datetime import date

import pytest
from pydantic import ValidationError

from retrieval.models import ChatRequest, SearchRequest, SearchResult


def make_result(
    *,
    jurisdiction: str = "CH",
    collection: str = "SR",
    number: str = "220",
    lang: str = "de",
    article: str = "1",
    part: int | None = None,
    eid: str = "art_1",
    heading: str | None = None,
    context: str | None = None,
    text: str = "text",
    source_url: str = "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_1",
    act_name: str = "Code of Obligations",
    abbrev: str = "CO",
    version_date: date = date(2026, 1, 1),
    score: float = 0.5,
) -> SearchResult:
    return SearchResult(
        jurisdiction=jurisdiction,
        collection=collection,
        number=number,
        lang=lang,
        article=article,
        part=part,
        eid=eid,
        heading=heading,
        context=context,
        text=text,
        source_url=source_url,
        act_name=act_name,
        abbrev=abbrev,
        version_date=version_date,
        score=score,
    )


def test_request_defaults() -> None:
    request = SearchRequest(q="Kündigungsfrist", lang="de")
    assert request.k == 5


@pytest.mark.parametrize("payload", [
    {"q": "", "lang": "de"},
    {"q": "x", "lang": "en"},
    {"q": "x", "lang": "de", "k": 0},
    {"q": "x", "lang": "de", "k": 21},
])
def test_request_rejects_invalid(payload: dict) -> None:
    with pytest.raises(ValidationError):
        SearchRequest.model_validate(payload)


def test_search_request_k_accepts_bounds() -> None:
    assert SearchRequest(q="x", lang="de", k=1).k == 1
    assert SearchRequest(q="x", lang="de", k=20).k == 20


def test_search_request_k_rejects_out_of_bounds() -> None:
    with pytest.raises(ValidationError):
        SearchRequest(q="x", lang="de", k=0)
    with pytest.raises(ValidationError):
        SearchRequest(q="x", lang="de", k=21)


def test_search_request_q_accepts_max_length() -> None:
    assert SearchRequest(q="x" * 2000, lang="de").q == "x" * 2000


def test_search_request_q_rejects_over_max_length() -> None:
    with pytest.raises(ValidationError):
        SearchRequest(q="x" * 2001, lang="de")


def test_chat_request_question_accepts_max_length() -> None:
    assert ChatRequest(question="x" * 2000).question == "x" * 2000


def test_chat_request_question_rejects_over_max_length() -> None:
    with pytest.raises(ValidationError):
        ChatRequest(question="x" * 2001)


def test_search_request_accepts_canton() -> None:
    req = SearchRequest(q="steuern", lang="de", canton="SG")
    assert req.canton == "SG"


def test_search_request_rejects_unknown_canton() -> None:
    with pytest.raises(ValidationError):
        SearchRequest(q="steuern", lang="de", canton="XX")


def test_chat_request_accepts_canton() -> None:
    req = ChatRequest(question="steuern", canton="SG")
    assert req.canton == "SG"


def test_chat_request_rejects_unknown_canton() -> None:
    with pytest.raises(ValidationError):
        ChatRequest(question="steuern", canton="XX")


def test_citation_label() -> None:
    r = make_result(collection="sGS", number="811.1", article="2")
    assert r.citation_label == "sGS 811.1 Art. 2"
