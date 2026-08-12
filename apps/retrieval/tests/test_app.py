import json
from datetime import date

import psycopg
from fastapi.testclient import TestClient

from retrieval.app import ArticleDeps, create_app
from retrieval.db import ChunkRow
from retrieval.search import SearchDeps
from retrieval.security import RateLimiter
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


def test_ready_returns_200_when_all_checks_pass(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.app.check_postgres", lambda settings: True)
    monkeypatch.setattr("retrieval.app.check_ollama", lambda client, settings: True)
    monkeypatch.setattr("retrieval.app.check_corpus", lambda settings: True)
    with _client(deps_with([])) as client:
        response = client.get("/ready")

    assert response.status_code == 200
    assert response.json() == {
        "ready": True,
        "checks": {"postgres": True, "ollama": True, "corpus": True},
    }


def test_ready_returns_503_when_postgres_check_fails(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.app.check_postgres", lambda settings: False)
    monkeypatch.setattr("retrieval.app.check_ollama", lambda client, settings: True)
    monkeypatch.setattr("retrieval.app.check_corpus", lambda settings: True)
    with _client(deps_with([])) as client:
        response = client.get("/ready")

    assert response.status_code == 503
    assert response.json() == {
        "ready": False,
        "checks": {"postgres": False, "ollama": True, "corpus": True},
    }


def test_ready_returns_503_when_ollama_check_fails(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.app.check_postgres", lambda settings: True)
    monkeypatch.setattr("retrieval.app.check_ollama", lambda client, settings: False)
    monkeypatch.setattr("retrieval.app.check_corpus", lambda settings: True)
    with _client(deps_with([])) as client:
        response = client.get("/ready")

    assert response.status_code == 503
    assert response.json() == {
        "ready": False,
        "checks": {"postgres": True, "ollama": False, "corpus": True},
    }


def test_ready_returns_503_when_corpus_check_fails(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.app.check_postgres", lambda settings: True)
    monkeypatch.setattr("retrieval.app.check_ollama", lambda client, settings: True)
    monkeypatch.setattr("retrieval.app.check_corpus", lambda settings: False)
    with _client(deps_with([])) as client:
        response = client.get("/ready")

    assert response.status_code == 503
    assert response.json() == {
        "ready": False,
        "checks": {"postgres": True, "ollama": True, "corpus": False},
    }


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
            "label": "SR 220 Art. 3",
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


def test_search_stays_open_when_api_key_is_unset() -> None:
    with _client(deps_with([])) as client:
        response = client.post("/search", json={"q": "frage", "lang": "de"})

    assert response.status_code == 200


def test_search_requires_api_key_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("API_KEY", "secret-key")
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        no_header = client.post("/search", json={"q": "frage", "lang": "de"})
        wrong_header = client.post(
            "/search", json={"q": "frage", "lang": "de"}, headers={"X-API-Key": "wrong"}
        )
        correct_header = client.post(
            "/search", json={"q": "frage", "lang": "de"}, headers={"X-API-Key": "secret-key"}
        )

    assert no_header.status_code == 401
    assert no_header.json() == {"detail": "invalid or missing API key"}
    assert wrong_header.status_code == 401
    assert correct_header.status_code == 200


def test_chat_requires_api_key_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("API_KEY", "secret-key")
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        no_header = client.post("/chat", json={"question": "frage", "lang": "de"})
        correct_header = client.post(
            "/chat",
            json={"question": "frage", "lang": "de"},
            headers={"X-API-Key": "secret-key"},
        )

    assert no_header.status_code == 401
    assert correct_header.status_code == 200


def test_ingest_endpoints_require_api_key_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("API_KEY", "secret-key")
    monkeypatch.setattr(
        "retrieval.app.ingest_status", lambda state, url: {"running": False}
    )
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        no_header = client.get("/ingest/status")
        correct_header = client.get("/ingest/status", headers={"X-API-Key": "secret-key"})

    assert no_header.status_code == 401
    assert correct_header.status_code == 200


def test_health_and_ready_stay_open_when_api_key_configured(monkeypatch) -> None:
    monkeypatch.setenv("API_KEY", "secret-key")
    monkeypatch.setattr("retrieval.app.check_postgres", lambda settings: True)
    monkeypatch.setattr("retrieval.app.check_ollama", lambda client, settings: True)
    monkeypatch.setattr("retrieval.app.check_corpus", lambda settings: True)
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        health = client.get("/health")
        ready = client.get("/ready")

    assert health.status_code == 200
    assert ready.status_code == 200


def test_search_rate_limit_disabled_by_default_allows_bursts() -> None:
    with _client(deps_with([])) as client:
        responses = [
            client.post("/search", json={"q": "frage", "lang": "de"}) for _ in range(20)
        ]

    assert all(r.status_code == 200 for r in responses)


def test_cors_preflight_succeeds_when_api_key_configured(monkeypatch) -> None:
    # enforce_security must not sit outside CORSMiddleware: a preflight OPTIONS
    # carries no X-API-Key header, so if security ran first it would 401 every
    # cross-origin request before CORS ever got a chance to answer it.
    monkeypatch.setenv("API_KEY", "secret-key")
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        response = client.options(
            "/chat",
            headers={
                "Origin": "http://localhost:1420",
                "Access-Control-Request-Method": "POST",
            },
        )

    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "http://localhost:1420"


def test_cors_headers_present_on_401_response(monkeypatch) -> None:
    # A 401 from enforce_security must still carry CORS headers, or the desktop
    # webview's fetch() rejects it as a CORS failure instead of surfacing the 401.
    monkeypatch.setenv("API_KEY", "secret-key")
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        response = client.post(
            "/search",
            json={"q": "frage", "lang": "de"},
            headers={"Origin": "http://localhost:1420"},
        )

    assert response.status_code == 401
    assert response.headers.get("access-control-allow-origin") == "http://localhost:1420"


def test_search_rate_limited_after_burst_then_refills_with_fake_clock() -> None:
    clock = {"t": 0.0}
    app = create_app()
    app.state.deps = deps_with([])
    app.state.rate_limiter = RateLimiter(2, clock=lambda: clock["t"])
    with TestClient(app) as client:
        first = client.post("/search", json={"q": "frage", "lang": "de"})
        second = client.post("/search", json={"q": "frage", "lang": "de"})
        third = client.post("/search", json={"q": "frage", "lang": "de"})
        clock["t"] += 30.0  # half the window at 2/min = 1 token refilled
        fourth = client.post("/search", json={"q": "frage", "lang": "de"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert third.status_code == 429
    assert third.json() == {"detail": "rate limit exceeded"}
    assert fourth.status_code == 200


def test_rate_limit_shared_across_rate_limited_post_endpoints() -> None:
    app = create_app()
    app.state.deps = deps_with([])
    app.state.rate_limiter = RateLimiter(1, clock=lambda: 0.0)
    with TestClient(app) as client:
        first = client.post("/search", json={"q": "frage", "lang": "de"})
        second = client.post("/ingest")

    assert first.status_code == 200
    assert second.status_code == 429


def test_rate_limit_does_not_apply_to_get_endpoints(monkeypatch) -> None:
    monkeypatch.setattr(
        "retrieval.app.ingest_status", lambda state, url: {"running": False}
    )
    app = create_app()
    app.state.deps = deps_with([])
    app.state.rate_limiter = RateLimiter(1, clock=lambda: 0.0)
    with TestClient(app) as client:
        responses = [client.get("/ingest/status") for _ in range(5)]

    assert all(r.status_code == 200 for r in responses)


def _chunk_row(part: int, text: str, lang: str = "fr") -> ChunkRow:
    return ChunkRow(
        id=part + 1, sr="220", lang=lang, article="335b", part=part or None,
        eid="art_335_b", heading="During the trial period", context=None, text=text,
        eli=f"https://www.fedlex.admin.ch/eli/cc/27/317_321_377/{lang}#art_335_b",
        act_name="Code of Obligations", abbrev="CO", version_date=date(2026, 1, 1),
    )


def test_article_returns_ordered_parts() -> None:
    app = create_app()
    app.state.deps = deps_with([])
    app.state.article_deps = ArticleDeps(
        rows=lambda sr, article, lang: [_chunk_row(1, "part one"), _chunk_row(2, "part two")],
        langs=lambda sr, article: ["de", "fr", "it"],
    )
    with TestClient(app) as client:
        response = client.get("/article", params={"sr": "220", "article": "335b", "lang": "fr"})

    assert response.status_code == 200
    body = response.json()
    assert body["texts"] == ["part one", "part two"]
    assert body["available_langs"] == ["de", "fr", "it"]
    assert body["act_name"] == "Code of Obligations"
    assert body["eli"].endswith("#art_335_b")


def test_article_404_when_missing_everywhere() -> None:
    app = create_app()
    app.state.deps = deps_with([])
    app.state.article_deps = ArticleDeps(
        rows=lambda sr, article, lang: [], langs=lambda sr, article: [],
    )
    with TestClient(app) as client:
        response = client.get("/article", params={"sr": "999", "article": "1", "lang": "de"})

    assert response.status_code == 404
    assert "not found" in response.json()["detail"]


def test_article_404_names_other_langs() -> None:
    app = create_app()
    app.state.deps = deps_with([])
    app.state.article_deps = ArticleDeps(
        rows=lambda sr, article, lang: [], langs=lambda sr, article: ["de", "it"],
    )
    with TestClient(app) as client:
        response = client.get("/article", params={"sr": "220", "article": "335b", "lang": "fr"})

    assert response.status_code == 404
    assert "de, it" in response.json()["detail"]


def test_article_rejects_bad_lang() -> None:
    app = create_app()
    app.state.deps = deps_with([])
    with TestClient(app) as client:
        response = client.get("/article", params={"sr": "220", "article": "1", "lang": "en"})

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
