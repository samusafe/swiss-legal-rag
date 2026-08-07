import json

import httpx
import pytest

from evals.client import chat, search


def test_search_posts_query_and_returns_results_list():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/search"
        body = json.loads(request.content)
        assert body == {"q": "frage", "lang": "de", "k": 5}
        return httpx.Response(
            200,
            json={"results": [{"sr": "220", "article": "1"}], "took_ms": {"embed": 1}},
        )

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport) as http_client:
        results = search(http_client, "http://test", "frage", "de", 5)

    assert results == [{"sr": "220", "article": "1"}]


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
        "sr": "220",
        "article": "1",
        "eli": "https://example.org/eli",
        "resolved": True,
    }
    body = _sse_body(
        [
            ("sources", {"sources": [{"sr": "220"}]}),
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
        "sr": "220",
        "article": "1",
        "eli": "https://example.org/eli",
        "resolved": True,
    }
    body = _sse_body(
        [
            ("sources", {"sources": [{"sr": "220"}]}),
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
