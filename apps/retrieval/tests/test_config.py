from retrieval.config import Settings


def test_chat_model_defaults_to_qwen2_5_3b_instruct(monkeypatch) -> None:
    # Isolate from the repo-root .env (which already pins the new default) so this
    # test exercises config.py's own fallback, not the environment.
    monkeypatch.setattr("retrieval.config.load_dotenv", lambda: None)
    monkeypatch.delenv("OLLAMA_CHAT_MODEL", raising=False)
    settings = Settings.from_env()
    assert settings.chat_model == "qwen2.5:3b-instruct"
