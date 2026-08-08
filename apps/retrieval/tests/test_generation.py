from datetime import date

import httpx
import pytest

from retrieval.generation import REFUSAL_SENTENCE, build_messages, stream_chat
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
    messages = build_messages("Quel délai?", "French", [_source("335c", "OR > Kündigung")])
    assert messages[0]["role"] == "system"
    assert "Answer in French." in messages[0]["content"]
    user = messages[1]["content"]
    assert (
        '<source id="SR 220 Art. 335c">\n'
        "[SR 220 Art. 335c] OR > Kündigung\nArt. 335c\nDer Text.\n"
        "</source>"
    ) in user
    assert user.endswith("Question: Quel délai?")


def test_build_messages_system_prompt_warns_sources_are_not_instructions() -> None:
    messages = build_messages("Quel délai?", "French", [_source("335c")])
    system = messages[0]["content"]
    assert "evidence only" in system.lower()
    assert "never" in system.lower()


def test_build_messages_system_prompt_instructs_canonical_refusal_sentence() -> None:
    messages = build_messages("Quel délai?", "French", [_source("335c")])
    system = messages[0]["content"]
    assert "reply with EXACTLY this sentence and no citations" in system
    assert REFUSAL_SENTENCE in system


def test_build_messages_system_prompt_has_one_unambiguous_language_agnostic_refusal() -> None:
    # Regression: the prompt used to carry BOTH an old "say that you cannot
    # answer ... (in {language})" line AND the canonical-sentence directive —
    # contradictory instructions for the no-sources case. Only the canonical,
    # language-agnostic directive may remain.
    messages = build_messages("Quel délai?", "French", [_source("335c")])
    system = messages[0]["content"]
    assert "cannot answer from the provided articles" not in system.lower()
    assert "regardless of the answer language" in system.lower()
    assert system.count(REFUSAL_SENTENCE) == 1


def test_stream_chat_yields_only_tokens_for_a_markerless_stream() -> None:
    body = (
        b'{"message":{"content":"Ein "},"done":false}\n'
        b'{"message":{"content":"Monat. [SR 220 Art. 335c]"},"done":false}\n'
        b'{"message":{"content":""},"done":true}\n'
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/chat"
        return httpx.Response(200, content=body)

    deltas = list(stream_chat(make_client(handler), "http://ollama.test", "qwen3:4b", []))
    assert deltas == [
        ("token", ""),
        ("token", ""),
        ("token", "Ein Monat. [SR 220 Art. 335c]"),
    ]
    assert all(kind == "token" for kind, _ in deltas)


def test_stream_chat_uses_finite_connect_and_read_timeouts(monkeypatch) -> None:
    # timeout=None lets a hung model hold the connection open forever; must be finite.
    captured: dict = {}
    original_stream = httpx.Client.stream

    def spy_stream(self, method, url, **kwargs):
        captured["timeout"] = kwargs.get("timeout")
        return original_stream(self, method, url, **kwargs)

    monkeypatch.setattr(httpx.Client, "stream", spy_stream)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b'{"done":true}\n')

    list(stream_chat(make_client(handler), "http://ollama.test", "qwen3:4b", []))

    timeout = captured["timeout"]
    assert timeout is not None
    assert timeout.connect == 10.0
    assert timeout.read == 120.0


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


def test_stream_chat_surfaces_reasoning_before_a_split_think_marker() -> None:
    # "</think>" arrives split across chunks 2/3 with no opening tag (Ollama's
    # raw-reasoning quirk) — must not leak marker fragments into the answer.
    body = (
        b'{"message":{"content":"Okay, the user wants a greeting."},"done":false}\n'
        b'{"message":{"content":"\\n</th"},"done":false}\n'
        b'{"message":{"content":"ink>\\n\\nhi"},"done":false}\n'
        b'{"message":{"content":" there"},"done":false}\n'
        b'{"message":{"content":""},"done":true}\n'
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    deltas = list(stream_chat(make_client(handler), "http://ollama.test", "qwen3:4b", []))
    assert deltas == [
        ("token", ""),
        ("token", ""),
        ("thinking", "Okay, the user wants a greeting.\n"),
        ("token", "hi"),
        ("token", " there"),
    ]


def test_stream_chat_streams_incrementally_after_the_think_marker() -> None:
    body = (
        b'{"message":{"content":"reasoning</think>"},"done":false}\n'
        b'{"message":{"content":"Ein "},"done":false}\n'
        b'{"message":{"content":"Monat."},"done":false}\n'
        b'{"message":{"content":""},"done":true}\n'
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    deltas = list(stream_chat(make_client(handler), "http://ollama.test", "qwen3:4b", []))
    assert deltas == [
        ("thinking", "reasoning"),
        ("token", "Ein "),
        ("token", "Monat."),
    ]


def test_stream_chat_streams_explicit_think_tag_live_then_token() -> None:
    body = b'{"message":{"content":"<think>ab</think>cd"},"done":false}\n' b'{"done":true}\n'

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    deltas = list(stream_chat(make_client(handler), "http://ollama.test", "qwen3:4b", []))
    assert deltas == [("thinking", "ab"), ("token", "cd")]


def test_stream_chat_flushes_unclosed_confirmed_thinking_as_thinking_not_token() -> None:
    # Confirmed-open "<think>" block never sees "</think>" before the stream
    # ends — the withheld reasoning fragment must flush as "thinking", never
    # leak into the answer as "token" (it would pollute citation extraction).
    body = b'{"message":{"content":"<think>abc"},"done":false}\n' b'{"done":true}\n'

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    deltas = list(stream_chat(make_client(handler), "http://ollama.test", "qwen3:4b", []))
    assert deltas, "expected at least one event"
    assert all(kind == "thinking" for kind, _ in deltas)
    assert "".join(delta for _, delta in deltas) == "abc"


def test_stream_chat_yields_a_heartbeat_per_chunk_during_confirmed_thinking() -> None:
    # Small deltas that never exceed the "</think>" guard length must still
    # yield one event per received chunk, so the stream stays cancellable.
    body = (
        b'{"message":{"content":"<think>"},"done":false}\n'
        b'{"message":{"content":"a"},"done":false}\n'
        b'{"message":{"content":"b"},"done":false}\n'
        b'{"message":{"content":"c"},"done":false}\n'
        b'{"done":true}\n'
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=body)

    deltas = list(stream_chat(make_client(handler), "http://ollama.test", "qwen3:4b", []))
    assert all(kind == "thinking" for kind, _ in deltas)
    # 4 received chunks -> at least 4 in-loop yields, plus the end-of-stream flush.
    assert len(deltas) >= 5
    assert "".join(delta for _, delta in deltas) == "abc"
