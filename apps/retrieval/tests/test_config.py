from retrieval.config import Settings


def test_chat_model_defaults_to_qwen2_5_3b_instruct(monkeypatch) -> None:
    # Isolate from the repo-root .env (which already pins the new default) so this
    # test exercises config.py's own fallback, not the environment.
    monkeypatch.setattr("retrieval.config.load_dotenv", lambda: None)
    monkeypatch.delenv("OLLAMA_CHAT_MODEL", raising=False)
    settings = Settings.from_env()
    assert settings.chat_model == "qwen2.5:3b-instruct"


def test_api_key_defaults_to_none(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.config.load_dotenv", lambda: None)
    monkeypatch.delenv("API_KEY", raising=False)
    assert Settings.from_env().api_key is None


def test_api_key_reads_env(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.config.load_dotenv", lambda: None)
    monkeypatch.setenv("API_KEY", "secret-key")
    assert Settings.from_env().api_key == "secret-key"


def test_api_key_empty_string_means_disabled(monkeypatch) -> None:
    # .env.example ships `API_KEY=`; copying it must not enable auth.
    monkeypatch.setattr("retrieval.config.load_dotenv", lambda: None)
    monkeypatch.setenv("API_KEY", "")
    assert Settings.from_env().api_key is None


def test_rate_limit_per_minute_empty_string_means_disabled(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.config.load_dotenv", lambda: None)
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "")
    assert Settings.from_env().rate_limit_per_minute == 0


def test_rate_limit_per_minute_defaults_to_zero_disabled(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.config.load_dotenv", lambda: None)
    monkeypatch.delenv("RATE_LIMIT_PER_MINUTE", raising=False)
    assert Settings.from_env().rate_limit_per_minute == 0


def test_rate_limit_per_minute_reads_env(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.config.load_dotenv", lambda: None)
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "30")
    assert Settings.from_env().rate_limit_per_minute == 30


def test_reranker_revision_defaults_to_none(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.config.load_dotenv", lambda: None)
    monkeypatch.delenv("RERANKER_REVISION", raising=False)
    assert Settings.from_env().reranker_revision is None


def test_reranker_revision_reads_env(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.config.load_dotenv", lambda: None)
    monkeypatch.setenv("RERANKER_REVISION", "abc1234")
    assert Settings.from_env().reranker_revision == "abc1234"
