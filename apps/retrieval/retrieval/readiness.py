"""Dependency probes backing `GET /ready` (app.py). `/health` stays a static
200 for liveness; these checks are the real readiness signal for
orchestration/monitoring — each must report False rather than raise, so one
down dependency never 500s the endpoint."""

import httpx
import psycopg

from retrieval.config import Settings
from retrieval.db import connect
from retrieval.ingest import embedded_count


def check_postgres(settings: Settings) -> bool:
    try:
        conn = connect(settings)
    except psycopg.Error:
        return False
    try:
        conn.execute("SELECT 1")
        return True
    except psycopg.Error:
        return False
    finally:
        conn.close()


# A hung Ollama must not hold up /ready for the shared client's much longer
# default timeout — this is a liveness probe, not a chat request.
_OLLAMA_READY_TIMEOUT = 2.0


def check_ollama(client: httpx.Client, settings: Settings) -> bool:
    try:
        response = client.get(
            f"{settings.ollama_base_url}/api/tags", timeout=_OLLAMA_READY_TIMEOUT
        )
        response.raise_for_status()
        payload = response.json()
        names = {
            name
            for model in payload.get("models", [])
            for name in (model.get("name"), model.get("model"))
            if name
        }
    except (httpx.HTTPError, ValueError, AttributeError, TypeError):
        return False
    return settings.chat_model in names and settings.embedding_model in names


def check_corpus(settings: Settings) -> bool:
    try:
        return embedded_count(settings.database_url) > 0
    except psycopg.Error:
        return False
