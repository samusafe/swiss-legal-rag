import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    database_url: str
    ollama_base_url: str
    embedding_model: str
    reranker_model: str
    reranker_revision: str | None
    chat_model: str
    ingestion_python: str
    api_key: str | None
    rate_limit_per_minute: int

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()  # repo-root .env; defaults mirror .env.example
        return cls(
            database_url=os.environ.get(
                "DATABASE_URL", "postgresql://rag:rag-local-only@localhost:5432/swiss_legal_rag"
            ),
            ollama_base_url=os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434"),
            embedding_model=os.environ.get("EMBEDDING_MODEL", "bge-m3"),
            reranker_model=os.environ.get("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3"),
            # Pins the exact reranker weights (see README Security/Reproducibility);
            # unset by default because the correct revision hash depends on RERANKER_MODEL.
            reranker_revision=os.environ.get("RERANKER_REVISION"),
            chat_model=os.environ.get("OLLAMA_CHAT_MODEL", "qwen2.5:3b-instruct"),
            ingestion_python=os.environ.get("INGESTION_PYTHON", ""),
            # Opt-in auth: unset OR empty (the .env.example placeholder is
            # `API_KEY=`) means every endpoint stays open.
            api_key=os.environ.get("API_KEY", "").strip() or None,
            # Opt-in rate limiting: 0 (default) or empty disables it entirely.
            rate_limit_per_minute=int(os.environ.get("RATE_LIMIT_PER_MINUTE", "0") or "0"),
        )
