import pytest
from pydantic import ValidationError

from retrieval.models import SearchRequest


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
