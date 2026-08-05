from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import httpx
import psycopg
from fastapi import FastAPI, HTTPException

from retrieval.config import Settings
from retrieval.db import connect, dense_search, fts_search
from retrieval.embeddings import embed_query
from retrieval.models import SearchRequest, SearchResponse
from retrieval.rerank import Reranker
from retrieval.search import SearchDeps, run_search


def _db_host(database_url: str) -> str:
    # host:port only — never leak credentials from the connection string.
    parsed = urlsplit(database_url)
    return f"{parsed.hostname}:{parsed.port}" if parsed.port else str(parsed.hostname)


def _build_deps(settings: Settings) -> SearchDeps:
    conn = connect(settings)
    client = httpx.Client(timeout=60.0)
    reranker = Reranker(settings.reranker_model)
    return SearchDeps(
        embed=lambda text: embed_query(
            client, settings.ollama_base_url, settings.embedding_model, text
        ),
        dense=lambda vector, k: dense_search(conn, vector, k),
        fts=lambda q, lang, k: fts_search(conn, q, lang, k),
        rerank=reranker.scores,
    )


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if app.state.deps is None:  # tests inject fakes before startup
            app.state.deps = _build_deps(Settings.from_env())
        yield

    app = FastAPI(title="swiss-legal-rag retrieval", lifespan=lifespan)
    app.state.deps = None

    @app.post("/search")
    def search(request: SearchRequest) -> SearchResponse:
        try:
            return run_search(app.state.deps, request)
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except psycopg.Error as error:
            host = _db_host(Settings.from_env().database_url)
            raise HTTPException(
                status_code=503,
                detail=(
                    f"database unavailable at {host} — is `docker compose up -d` running?"
                ),
            ) from error

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
