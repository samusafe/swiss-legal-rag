import json

import psycopg
from fastapi.testclient import TestClient

from retrieval.app import create_app
from retrieval.search import SearchDeps
from tests.test_search import deps_with


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


def test_search_drops_deps_after_db_error_so_next_request_reconnects() -> None:
    def failing_dense(vector: list[float], k: int) -> list:
        raise psycopg.OperationalError("connection refused")

    deps = SearchDeps(
        embed=lambda text: [0.0] * 1024,
        dense=failing_dense,
        fts=lambda q, lang, k: [],
        rerank=lambda q, texts: [],
    )
    app = create_app()
    app.state.deps = deps
    with TestClient(app) as client:
        response = client.post("/search", json={"q": "frage", "lang": "de"})
        assert response.status_code == 503
        # deps dropped: the next request rebuilds (and reconnects) instead of
        # reusing a dead connection forever.
        assert app.state.deps is None


def _parse_sse(body: str) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []
    for block in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        events.append((lines["event"], json.loads(lines["data"])))
    return events


def test_chat_streams_sources_tokens_done(monkeypatch) -> None:
    def fake_stream(client, base_url, model, messages):
        yield "Gamma gilt "
        yield "[SR 220 Art. 3]."

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
    assert done["model"] == "qwen3:4b"
    assert isinstance(done["duration_ms"], int)


def test_chat_emits_error_event_when_generation_dies_mid_stream(monkeypatch) -> None:
    def dying_stream(client, base_url, model, messages):
        yield "Ein "
        raise RuntimeError("Ollama unreachable at http://localhost:11434")

    monkeypatch.setattr("retrieval.app.stream_chat", dying_stream)
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        response = client.post("/chat", json={"question": "frage", "lang": "de"})

    events = _parse_sse(response.text)
    assert [name for name, _ in events] == ["sources", "token", "error"]
    assert "Ollama unreachable" in events[-1][1]["detail"]


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
