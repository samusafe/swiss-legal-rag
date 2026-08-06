from datetime import date

import httpx
import pytest

from retrieval.generation import build_messages, stream_chat
from retrieval.models import SearchResult
from tests.conftest import make_client


def _source(article: str, context: str | None = None) -> SearchResult:
    return SearchResult(
        sr="220", lang="de", article=article, part=None, eid=f"art_{article}",
        heading=None, context=context, text=f"Art. {article}\nDer Text.",
        eli=f"https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_{article}",
        act_name="Code of Obligations", abbrev="OR", version_date=date(2026, 1, 1),
        score=0.9,
    )


def test_build_messages_labels_articles_and_fixes_answer_language() -> None:
    messages = build_messages("Quel délai?", "fr", [_source("335c", "OR > Kündigung")])
    assert messages[0]["role"] == "system"
    assert "Answer in French." in messages[0]["content"]
    user = messages[1]["content"]
    assert "[SR 220 Art. 335c] OR > Kündigung\nArt. 335c\nDer Text." in user
    assert user.endswith("Question: Quel délai?")


def test_build_messages_rejects_unknown_lang() -> None:
    with pytest.raises(KeyError):
        build_messages("q", "en", [])


def test_stream_chat_yields_deltas_until_done() -> None:
    body = (
        b'{"message":{"content":"Ein "},"done":false}\n'
        b'{"message":{"content":"Monat. [SR 220 Art. 335c]"},"done":false}\n'
        b'{"message":{"content":""},"done":true}\n'
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/chat"
        return httpx.Response(200, content=body)

    deltas = list(stream_chat(make_client(handler), "http://ollama.test", "qwen3:4b", []))
    assert deltas == ["Ein ", "Monat. [SR 220 Art. 335c]"]


def test_stream_chat_raises_runtime_error_when_ollama_unreachable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    with pytest.raises(RuntimeError, match="ollama.test"):
        list(stream_chat(make_client(handler), "http://ollama.test", "qwen3:4b", []))


def test_stream_chat_raises_runtime_error_on_http_error_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, content=b"model not found")

    with pytest.raises(RuntimeError, match="404"):
        list(stream_chat(make_client(handler), "http://ollama.test", "missing", []))


def test_stream_chat_raises_runtime_error_on_in_stream_error_payload() -> None:
    body = (
        b'{"message":{"content":"Ein "},"done":false}\n'
        b'{"error":"model exited unexpectedly"}\n'
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    with pytest.raises(RuntimeError, match="model exited unexpectedly"):
        list(stream_chat(make_client(handler), "http://ollama.test", "qwen3:4b", []))


def test_stream_chat_raises_runtime_error_on_malformed_line() -> None:
    body = b'not json\n'

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    with pytest.raises(RuntimeError, match="unexpected payload"):
        list(stream_chat(make_client(handler), "http://ollama.test", "qwen3:4b", []))
