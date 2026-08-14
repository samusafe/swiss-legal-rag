import json

import httpx
import pytest

from evals.client import auth_headers, chat, search


def test_search_posts_query_and_returns_results_list():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/search"
        body = json.loads(request.content)
        assert body == {"q": "frage", "lang": "de", "k": 5}
        return httpx.Response(
            200,
            json={
                "results": [{"collection": "SR", "number": "220", "article": "1"}],
                "took_ms": {"embed": 1},
            },
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        results = search(http_client, "http://test", "frage", "de", 5)

    assert results == [{"collection": "SR", "number": "220", "article": "1"}]


def test_search_raises_on_non_200():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="db down")

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        with pytest.raises(httpx.HTTPStatusError):
            search(http_client, "http://test", "frage", "de", 5)


def _sse_body(events: list[tuple[str, dict]]) -> bytes:
    frames = [f"event: {event}\ndata: {json.dumps(data)}\n\n" for event, data in events]
    return "".join(frames).encode("utf-8")


def test_chat_posts_question_and_assembles_answer_and_citations():
    citation = {
        "raw": "[SR 220 Art. 1]",
        "collection": "SR",
        "number": "220",
        "article": "1",
        "citation_label": "SR 220 Art. 1",
        "source_url": "https://example.org/source",
        "resolved": True,
    }
    body = _sse_body(
        [
            ("sources", {"sources": [{"collection": "SR", "number": "220"}]}),
            ("token", {"delta": "Hello "}),
            ("token", {"delta": "world"}),
            ("done", {"citations": [citation], "model": "m", "duration_ms": 5}),
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/chat"
        body_json = json.loads(request.content)
        assert body_json == {"question": "frage", "lang": "de", "k": 5}
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        answer, citations = chat(http_client, "http://test", "frage", "de", 5)

    assert answer == "Hello world"
    assert citations == [citation]


def test_chat_tolerates_unknown_thinking_event_between_sources_and_token():
    citation = {
        "raw": "[SR 220 Art. 1]",
        "collection": "SR",
        "number": "220",
        "article": "1",
        "citation_label": "SR 220 Art. 1",
        "source_url": "https://example.org/source",
        "resolved": True,
    }
    body = _sse_body(
        [
            ("sources", {"sources": [{"collection": "SR", "number": "220"}]}),
            ("thinking", {"delta": "hmm, checking the article..."}),
            ("token", {"delta": "Hello "}),
            ("token", {"delta": "world"}),
            ("done", {"citations": [citation], "model": "m", "duration_ms": 5}),
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body, headers={"content-type": "text/event-stream"})

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        answer, citations = chat(http_client, "http://test", "frage", "de", 5)

    assert answer == "Hello world"
    assert citations == [citation]


def test_chat_raises_runtime_error_on_error_event():
    body = _sse_body(
        [
            ("sources", {"sources": []}),
            ("token", {"delta": "partial"}),
            ("error", {"detail": "Ollama unreachable"}),
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        with pytest.raises(RuntimeError, match="Ollama unreachable"):
            chat(http_client, "http://test", "frage", "de", 5)


def test_chat_raises_runtime_error_when_stream_ends_without_done():
    body = _sse_body([("sources", {"sources": []}), ("token", {"delta": "hi"})])

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        with pytest.raises(RuntimeError):
            chat(http_client, "http://test", "frage", "de", 5)


def test_chat_raises_runtime_error_on_non_200():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="down")

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        with pytest.raises(RuntimeError):
            chat(http_client, "http://test", "frage", "de", 5)


def test_auth_headers_empty_when_api_key_is_none():
    assert auth_headers(None) == {}


def test_auth_headers_empty_when_api_key_is_empty_string():
    assert auth_headers("") == {}


def test_auth_headers_carries_x_api_key_when_set():
    assert auth_headers("secret-key") == {"X-API-Key": "secret-key"}


def test_search_sends_x_api_key_header_when_provided():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("x-api-key") == "secret-key"
        return httpx.Response(
            200, json={"results": [], "took_ms": {"embed": 1}}
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        search(http_client, "http://test", "frage", "de", 5, api_key="secret-key")


def test_search_omits_x_api_key_header_when_not_provided():
    def handler(request: httpx.Request) -> httpx.Response:
        assert "x-api-key" not in request.headers
        return httpx.Response(
            200, json={"results": [], "took_ms": {"embed": 1}}
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        search(http_client, "http://test", "frage", "de", 5)


def test_chat_sends_x_api_key_header_when_provided():
    body = _sse_body([("sources", {"sources": []}), ("done", {"citations": []})])

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("x-api-key") == "secret-key"
        return httpx.Response(200, content=body)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        chat(http_client, "http://test", "frage", "de", 5, api_key="secret-key")


def test_chat_omits_x_api_key_header_when_not_provided():
    body = _sse_body([("sources", {"sources": []}), ("done", {"citations": []})])

    def handler(request: httpx.Request) -> httpx.Response:
        assert "x-api-key" not in request.headers
        return httpx.Response(200, content=body)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        chat(http_client, "http://test", "frage", "de", 5)


def test_search_omits_canton_from_body_when_not_provided():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body == {"q": "frage", "lang": "de", "k": 5}
        assert "canton" not in body
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        search(http_client, "http://test", "frage", "de", 5)


def test_search_sends_canton_in_body_when_provided():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body == {"q": "frage", "lang": "de", "k": 5, "canton": "SG"}
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        search(http_client, "http://test", "frage", "de", 5, canton="SG")


def test_chat_omits_canton_from_body_when_not_provided():
    body = _sse_body([("sources", {"sources": []}), ("done", {"citations": []})])

    def handler(request: httpx.Request) -> httpx.Response:
        body_json = json.loads(request.content)
        assert body_json == {"question": "frage", "lang": "de", "k": 5}
        assert "canton" not in body_json
        return httpx.Response(200, content=body)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        chat(http_client, "http://test", "frage", "de", 5)


def test_chat_sends_canton_in_body_when_provided():
    body = _sse_body([("sources", {"sources": []}), ("done", {"citations": []})])

    def handler(request: httpx.Request) -> httpx.Response:
        body_json = json.loads(request.content)
        assert body_json == {"question": "frage", "lang": "de", "k": 5, "canton": "BE"}
        return httpx.Response(200, content=body)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        chat(http_client, "http://test", "frage", "de", 5, canton="BE")
