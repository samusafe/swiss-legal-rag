from collections.abc import Callable
from typing import Any

import httpx
import pytest


def sparql_row(lang_tag: str, date_str: str, file_url: str) -> dict[str, Any]:
    return {
        "sr": {"type": "literal", "value": "220"},
        "dateApplicability": {
            "type": "typed-literal",
            "datatype": "http://www.w3.org/2001/XMLSchema#date",
            "value": date_str,
        },
        "languageTag": {"type": "literal", "value": lang_tag},
        "fileUrl": {"type": "uri", "value": file_url},
    }


def sparql_response(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "head": {"vars": ["sr", "dateApplicability", "languageTag", "fileUrl"]},
        "results": {"bindings": rows},
    }


def make_client(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.fixture
def canned_rows() -> list[dict[str, Any]]:
    base = "https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/27/317_321_377"
    return [
        sparql_row("DEU", "2026-10-01", f"{base}/20261001/de/xml/a-de.xml"),
        sparql_row("DEU", "2026-01-01", f"{base}/20260101/de/xml/a-de.xml"),
        sparql_row("FRA", "2026-01-01", f"{base}/20260101/fr/xml/a-fr.xml"),
        sparql_row("ITA", "2026-01-01", f"{base}/20260101/it/xml/a-it.xml"),
    ]


@pytest.fixture
def sparql_client(canned_rows: list[dict[str, Any]]) -> httpx.Client:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=sparql_response(canned_rows))

    return make_client(handler)


AKN_NS = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0"
FEDLEX_NS = "http://fedlex.admin.ch/"


def akn_doc(body_xml: str) -> bytes:
    return (
        f'<akomaNtoso xmlns="{AKN_NS}" xmlns:fedlex="{FEDLEX_NS}">'
        f"<act><body>{body_xml}</body></act></akomaNtoso>"
    ).encode()
