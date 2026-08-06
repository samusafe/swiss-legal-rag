import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    database_url: str
    ollama_base_url: str
    embedding_model: str
    reranker_model: str
    chat_model: str

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
            chat_model=os.environ.get("OLLAMA_CHAT_MODEL", "qwen3:4b"),
        )
