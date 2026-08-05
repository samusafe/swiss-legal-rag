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
