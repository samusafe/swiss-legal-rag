import httpx
import psycopg

from retrieval.config import Settings
from retrieval.readiness import check_corpus, check_ollama, check_postgres
from tests.conftest import make_client


def _settings(**overrides) -> Settings:
    base = dict(
        database_url="postgresql://ignored",
        ollama_base_url="http://ollama.test",
        embedding_model="bge-m3",
        reranker_model="BAAI/bge-reranker-v2-m3",
        reranker_revision=None,
        chat_model="qwen2.5:3b-instruct",
        ingestion_python="",
        api_key=None,
        rate_limit_per_minute=0,
    )
    base.update(overrides)
    return Settings(**base)


class FakeConn:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail
        self.closed = False

    def execute(self, query: str) -> None:
        if self.fail:
            raise psycopg.OperationalError("connection refused")

    def close(self) -> None:
        self.closed = True


def test_check_postgres_true_when_select_1_succeeds(monkeypatch) -> None:
    conn = FakeConn()
    monkeypatch.setattr("retrieval.readiness.connect", lambda settings: conn)

    assert check_postgres(_settings()) is True
    assert conn.closed is True


def test_check_postgres_false_when_connect_raises(monkeypatch) -> None:
    def failing_connect(settings: Settings) -> None:
        raise psycopg.OperationalError("connection refused")

    monkeypatch.setattr("retrieval.readiness.connect", failing_connect)

    assert check_postgres(_settings()) is False


def test_check_postgres_false_when_execute_raises(monkeypatch) -> None:
    conn = FakeConn(fail=True)
    monkeypatch.setattr("retrieval.readiness.connect", lambda settings: conn)

    assert check_postgres(_settings()) is False
    assert conn.closed is True


def test_check_ollama_true_when_both_models_present() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/tags"
        return httpx.Response(
            200,
            json={
                "models": [
                    {"name": "qwen2.5:3b-instruct"},
                    {"name": "bge-m3:latest", "model": "bge-m3:latest"},
                ]
            },
        )

    client = make_client(handler)
    settings = _settings(embedding_model="bge-m3:latest")

    assert check_ollama(client, settings) is True


def test_check_ollama_false_when_chat_model_missing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": [{"name": "bge-m3"}]})

    client = make_client(handler)

    assert check_ollama(client, _settings()) is False


def test_check_ollama_false_when_embed_model_missing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": [{"name": "qwen2.5:3b-instruct"}]})

    client = make_client(handler)

    assert check_ollama(client, _settings()) is False


def test_check_ollama_false_when_ollama_unreachable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = make_client(handler)

    assert check_ollama(client, _settings()) is False


def test_check_ollama_false_on_non_200_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    client = make_client(handler)

    assert check_ollama(client, _settings()) is False


def test_check_corpus_true_when_embedded_chunks_present(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.readiness.embedded_count", lambda url: 5)

    assert check_corpus(_settings()) is True


def test_check_corpus_false_when_no_embedded_chunks(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.readiness.embedded_count", lambda url: 0)

    assert check_corpus(_settings()) is False


def test_check_corpus_false_when_embedded_count_raises(monkeypatch) -> None:
    def failing_embedded_count(url: str) -> int:
        raise psycopg.OperationalError("connection refused")

    monkeypatch.setattr("retrieval.readiness.embedded_count", failing_embedded_count)

    assert check_corpus(_settings()) is False


def test_check_ollama_uses_a_short_per_call_timeout(monkeypatch) -> None:
    # A hung Ollama must not block /ready for the shared client's 60s default.
    captured: dict = {}
    original_get = httpx.Client.get

    def spy_get(self, url, **kwargs):
        captured["timeout"] = kwargs.get("timeout")
        return original_get(self, url, **kwargs)

    monkeypatch.setattr(httpx.Client, "get", spy_get)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": []})

    client = make_client(handler)
    check_ollama(client, _settings())

    assert captured["timeout"] == 2.0


def test_check_ollama_false_on_non_dict_json_payload() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=["unexpected", "list"])

    client = make_client(handler)

    assert check_ollama(client, _settings()) is False


def test_check_ollama_false_on_malformed_models_entries() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"models": ["not-a-dict"]})

    client = make_client(handler)

    assert check_ollama(client, _settings()) is False
