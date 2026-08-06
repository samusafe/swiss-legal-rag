import json
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import httpx
import psycopg
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from retrieval.citations import extract_citations
from retrieval.config import Settings
from retrieval.db import connect, dense_search, fts_search
from retrieval.embeddings import embed_query
from retrieval.generation import build_messages, stream_chat
from retrieval.models import ChatRequest, SearchRequest, SearchResponse
from retrieval.rerank import Reranker
from retrieval.search import SearchDeps, run_search


def _db_host(database_url: str) -> str:
    # host:port only — never leak credentials from the connection string.
    parsed = urlsplit(database_url)
    return f"{parsed.hostname}:{parsed.port}" if parsed.port else str(parsed.hostname)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _connect_deps(app: FastAPI) -> None:
    settings = app.state.settings
    conn = connect(settings)
    if app.state.client is None:
        app.state.client = httpx.Client(timeout=60.0)
    client = app.state.client
    reranker = Reranker(settings.reranker_model)
    app.state.conn = conn
    app.state.deps = SearchDeps(
        embed=lambda text: embed_query(
            client, settings.ollama_base_url, settings.embedding_model, text
        ),
        dense=lambda vector, k: dense_search(conn, vector, k),
        fts=lambda q, lang, k: fts_search(conn, q, lang, k),
        rerank=reranker.scores,
    )


def _drop_deps(app: FastAPI) -> None:
    # No-op for injected fakes: conn stays None there. Deliberately leaves
    # app.state.client alone — a psycopg.Error on /search must not tear the
    # shared httpx client out from under an in-flight /chat stream.
    if app.state.conn is not None:
        app.state.conn.close()
        app.state.conn = None
    app.state.deps = None


def _close_client(app: FastAPI) -> None:
    if app.state.client is not None:
        app.state.client.close()
        app.state.client = None


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = Settings.from_env()
        if app.state.deps is None:  # tests inject fakes before startup
            _connect_deps(app)
        yield
        _drop_deps(app)
        _close_client(app)

    app = FastAPI(title="swiss-legal-rag retrieval", lifespan=lifespan)
    app.state.deps = None
    app.state.conn = None
    app.state.client = None

    @app.post("/search")
    def search(request: SearchRequest) -> SearchResponse:
        try:
            if app.state.deps is None:  # dropped after a DB failure — reconnect now
                _connect_deps(app)
            return run_search(app.state.deps, request)
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except psycopg.Error as error:
            _drop_deps(app)  # dead connection: next request rebuilds instead of failing forever
            host = _db_host(app.state.settings.database_url)
            raise HTTPException(
                status_code=503,
                detail=(
                    f"database unavailable at {host} — is `docker compose up -d` running?"
                ),
            ) from error

    _SOURCE_FIELDS = {"sr", "article", "heading", "eli", "lang", "score"}

    @app.post("/chat")
    def chat(request: ChatRequest) -> StreamingResponse:
        try:
            if app.state.deps is None:
                _connect_deps(app)
            search_response = run_search(
                app.state.deps,
                SearchRequest(q=request.question, lang=request.lang, k=request.k),
            )
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except psycopg.Error as error:
            _drop_deps(app)
            host = _db_host(app.state.settings.database_url)
            raise HTTPException(
                status_code=503,
                detail=(
                    f"database unavailable at {host} — is `docker compose up -d` running?"
                ),
            ) from error

        settings = app.state.settings
        if app.state.client is None:  # deps were injected without a real client
            app.state.client = httpx.Client(timeout=60.0)
        client = app.state.client
        sources = search_response.results
        messages = build_messages(request.question, request.lang, sources)

        def events() -> Iterator[str]:
            yield _sse(
                "sources",
                {"sources": [s.model_dump(include=_SOURCE_FIELDS) for s in sources]},
            )
            t0 = time.perf_counter()
            parts: list[str] = []
            try:
                for delta in stream_chat(
                    client, settings.ollama_base_url, settings.chat_model, messages
                ):
                    parts.append(delta)
                    yield _sse("token", {"delta": delta})
            except Exception as error:
                yield _sse("error", {"detail": str(error)})
                return
            citations = extract_citations("".join(parts), sources)
            yield _sse(
                "done",
                {
                    "citations": [c.model_dump() for c in citations],
                    "model": settings.chat_model,
                    "duration_ms": int((time.perf_counter() - t0) * 1000),
                },
            )

        return StreamingResponse(events(), media_type="text/event-stream")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
