import json

import psycopg
from fastapi.testclient import TestClient

from retrieval.app import create_app
from retrieval.search import SearchDeps
from tests.test_search import A, deps_with


def _client(deps: SearchDeps) -> TestClient:
    app = create_app()
    app.state.deps = deps
    return TestClient(app)


def test_search_happy_path_orders_and_reports_timings() -> None:
    with _client(deps_with([])) as client:
        response = client.post("/search", json={"q": "frage", "lang": "de"})

    assert response.status_code == 200
    body = response.json()
    assert [r["article"] for r in body["results"]] == ["3", "2", "1"]
    assert body["results"][0]["score"] == 0.9
    assert set(body["took_ms"]) == {"embed", "search", "rerank"}


def test_search_rejects_unsupported_lang() -> None:
    with _client(deps_with([])) as client:
        response = client.post("/search", json={"q": "frage", "lang": "en"})

    assert response.status_code == 422


def test_health_returns_ok() -> None:
    with _client(deps_with([])) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_cors_allows_desktop_webview_origins() -> None:
    with _client(deps_with([])) as client:
        response = client.get("/health", headers={"Origin": "http://localhost:1420"})

    assert response.headers["access-control-allow-origin"] == "http://localhost:1420"


def test_search_returns_503_when_ollama_unreachable() -> None:
    def failing_embed(text: str) -> list[float]:
        raise RuntimeError("Ollama down")

    deps = SearchDeps(
        embed=failing_embed,
        dense=lambda vector, k: [],
        fts=lambda q, lang, k: [],
        rerank=lambda q, texts: [],
    )
    with _client(deps) as client:
        response = client.post("/search", json={"q": "frage", "lang": "de"})

    assert response.status_code == 503
    assert "Ollama down" in response.json()["detail"]


def test_search_returns_503_when_db_unavailable() -> None:
    def failing_dense(vector: list[float], k: int) -> list:
        raise psycopg.OperationalError("connection refused")

    deps = SearchDeps(
        embed=lambda text: [0.0] * 1024,
        dense=failing_dense,
        fts=lambda q, lang, k: [],
        rerank=lambda q, texts: [],
    )
    with _client(deps) as client:
        response = client.post("/search", json={"q": "frage", "lang": "de"})

    assert response.status_code == 503
    assert "database unavailable" in response.json()["detail"]


def test_search_reconnects_and_recovers_on_next_request(monkeypatch) -> None:
    def failing_dense(vector: list[float], k: int) -> list:
        raise psycopg.OperationalError("connection refused")

    dead = SearchDeps(
        embed=lambda text: [0.0] * 1024,
        dense=failing_dense,
        fts=lambda q, lang, k: [],
        rerank=lambda q, texts: [],
    )
    app = create_app()
    app.state.deps = dead

    def fake_connect(app_) -> None:
        app_.state.deps = deps_with([])

    monkeypatch.setattr("retrieval.app._connect_deps", fake_connect)
    with TestClient(app) as client:
        first = client.post("/search", json={"q": "frage", "lang": "de"})
        assert first.status_code == 503
        assert app.state.deps is None  # dropped, so the next request rebuilds
        second = client.post("/search", json={"q": "frage", "lang": "de"})

    assert second.status_code == 200
    assert [r["article"] for r in second.json()["results"]] == ["3", "2", "1"]


def _parse_sse(body: str) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    for block in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        events.append((lines["event"], json.loads(lines["data"])))
    return events


def test_chat_streams_sources_tokens_done(monkeypatch) -> None:
    def fake_stream(client, base_url, model, messages):
        yield ("token", "Gamma gilt ")
        yield ("token", "[SR 220 Art. 3].")

    monkeypatch.setattr("retrieval.app.stream_chat", fake_stream)
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        response = client.post("/chat", json={"question": "frage", "lang": "de"})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = _parse_sse(response.text)
    assert [name for name, _ in events] == ["sources", "token", "token", "done"]
    sources = events[0][1]["sources"]
    assert [s["article"] for s in sources] == ["3", "2", "1"]
    assert {"sr", "article", "heading", "eli", "lang", "score"} <= set(sources[0])
    done = events[-1][1]
    assert done["citations"] == [
        {
            "raw": "[SR 220 Art. 3]",
            "sr": "220",
            "article": "3",
            "eli": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_3",
            "resolved": True,
        }
    ]
    assert done["model"] == app.state.settings.chat_model
    assert isinstance(done["duration_ms"], int)


def test_chat_streams_thinking_events_before_tokens(monkeypatch) -> None:
    def fake_stream(client, base_url, model, messages):
        yield ("thinking", "hmm, ")
        yield ("thinking", "let me check")
        yield ("token", "Gamma gilt.")

    monkeypatch.setattr("retrieval.app.stream_chat", fake_stream)
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        response = client.post("/chat", json={"question": "frage", "lang": "de"})

    events = _parse_sse(response.text)
    assert [name for name, _ in events] == ["sources", "thinking", "thinking", "token", "done"]
    assert events[1][1] == {"delta": "hmm, "}
    assert events[2][1] == {"delta": "let me check"}
    assert events[3][1] == {"delta": "Gamma gilt."}


def test_chat_emits_error_event_when_generation_dies_mid_stream(monkeypatch) -> None:
    def dying_stream(client, base_url, model, messages):
        yield ("token", "Ein ")
        raise RuntimeError("Ollama unreachable at http://localhost:11434")

    monkeypatch.setattr("retrieval.app.stream_chat", dying_stream)
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        response = client.post("/chat", json={"question": "frage", "lang": "de"})

    events = _parse_sse(response.text)
    assert [name for name, _ in events] == ["sources", "token", "error"]
    assert "Ollama unreachable" in events[-1][1]["detail"]


def test_chat_without_lang_detects_language_for_fts_and_prompt(monkeypatch) -> None:
    captured_messages: list = []

    def fake_build_messages(question, language, sources):
        captured_messages.append((question, language))
        return [{"role": "system", "content": "x"}, {"role": "user", "content": "y"}]

    def fake_stream(client, base_url, model, messages):
        yield ("token", "ok")

    monkeypatch.setattr("retrieval.app.detect_language", lambda text: "de")
    monkeypatch.setattr("retrieval.app.build_messages", fake_build_messages)
    monkeypatch.setattr("retrieval.app.stream_chat", fake_stream)
    langs: list[str] = []
    app = create_app()
    app.state.deps = deps_with(langs)
    with TestClient(app) as client:
        response = client.post("/chat", json={"question": "frage"})

    assert response.status_code == 200
    assert langs == ["de"]
    assert captured_messages == [("frage", "German")]


def test_chat_without_lang_falls_back_to_dense_only_when_undetected_lang(monkeypatch) -> None:
    def exploding_fts(q: str, lang: str, k: int) -> list:
        raise AssertionError("fts must not be called for an unsupported detected language")

    captured_messages: list = []

    def fake_build_messages(question, language, sources):
        captured_messages.append((question, language))
        return [{"role": "system", "content": "x"}, {"role": "user", "content": "y"}]

    def fake_stream(client, base_url, model, messages):
        yield ("token", "ok")

    monkeypatch.setattr("retrieval.app.detect_language", lambda text: "pt")
    monkeypatch.setattr("retrieval.app.build_messages", fake_build_messages)
    monkeypatch.setattr("retrieval.app.stream_chat", fake_stream)
    deps = SearchDeps(
        embed=lambda text: [0.0] * 1024,
        dense=lambda vector, k: [A],  # non-empty: exercises build_messages, not the refusal path
        fts=exploding_fts,
        rerank=lambda q, texts: [0.5],
    )
    app = create_app()
    app.state.deps = deps
    with TestClient(app) as client:
        response = client.post("/chat", json={"question": "frage"})

    assert response.status_code == 200
    assert captured_messages == [("frage", "Portuguese")]


def test_chat_refuses_without_calling_ollama_when_no_sources_retrieved(monkeypatch) -> None:
    def exploding_stream(client, base_url, model, messages):
        raise AssertionError("Ollama must not be called when retrieval returns no sources")

    monkeypatch.setattr("retrieval.app.stream_chat", exploding_stream)
    deps = SearchDeps(
        embed=lambda text: [0.0] * 1024,
        dense=lambda vector, k: [],
        fts=lambda q, lang, k: [],
        rerank=lambda q, texts: [],
    )
    app = create_app()
    app.state.deps = deps
    with TestClient(app) as client:
        response = client.post("/chat", json={"question": "frage", "lang": "de"})

    assert response.status_code == 200
    events = _parse_sse(response.text)
    assert [name for name, _ in events] == ["sources", "token", "done"]
    assert events[0][1]["sources"] == []
    assert events[1][1] == {
        "delta": "The current corpus contains no sources sufficient to answer this question."
    }
    done = events[-1][1]
    assert done["citations"] == []
    assert done["model"] == app.state.settings.chat_model
    assert isinstance(done["duration_ms"], int)


def test_chat_returns_503_when_retrieval_fails() -> None:
    def failing_embed(text: str) -> list[float]:
        raise RuntimeError("Ollama down")

    deps = SearchDeps(
        embed=failing_embed,
        dense=lambda vector, k: [],
        fts=lambda q, lang, k: [],
        rerank=lambda q, texts: [],
    )
    with _client(deps) as client:
        response = client.post("/chat", json={"question": "frage", "lang": "de"})

    assert response.status_code == 503


def test_chat_rejects_unsupported_lang() -> None:
    with _client(deps_with([])) as client:
        response = client.post("/chat", json={"question": "frage", "lang": "en"})

    assert response.status_code == 422


def test_chat_reuses_lazy_httpx_client_across_requests(monkeypatch) -> None:
    def fake_stream(client, base_url, model, messages):
        yield ("token", "ok")

    monkeypatch.setattr("retrieval.app.stream_chat", fake_stream)
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        assert client.post("/chat", json={"question": "frage", "lang": "de"}).status_code == 200
        first_client = app.state.client
        assert first_client is not None
        assert client.post("/chat", json={"question": "frage", "lang": "de"}).status_code == 200
        assert app.state.client is first_client
