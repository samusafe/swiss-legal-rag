import json
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import httpx
import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from retrieval.citations import extract_citations
from retrieval.config import Settings
from retrieval.db import connect, dense_search, fts_search
from retrieval.embeddings import embed_query
from retrieval.generation import REFUSAL_SENTENCE, build_messages, stream_chat
from retrieval.ingest import (
    IngestState,
    embedded_count,
    ingest_status,
    ingestion_python,
    phase_progress,
    start_ingest,
    stop_ingest,
)
from retrieval.language import (
    answer_language,
    answer_language_code,
    detect_language,
    fts_language,
)
from retrieval.models import ChatRequest, SearchRequest, SearchResponse
from retrieval.readiness import check_corpus, check_ollama, check_postgres
from retrieval.rerank import Reranker
from retrieval.search import SearchDeps, run_search
from retrieval.security import RateLimiter, verify_api_key

# Auth (when API_KEY is set) applies to every endpoint except these liveness/readiness
# probes. Rate limiting (when RATE_LIMIT_PER_MINUTE > 0) applies only to the POST
# endpoints below — GET status/progress/health/ready are never throttled.
_OPEN_PATHS = {"/health", "/ready"}
_RATE_LIMITED_PATHS = {"/search", "/chat", "/ingest", "/ingest/stop"}


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
    reranker = Reranker(settings.reranker_model, settings.reranker_revision)
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
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
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
    app.state.ingest = IngestState()
    app.state.rate_limiter = None  # lazily built from settings on first request

    @app.middleware("http")
    async def enforce_security(request: Request, call_next):  # type: ignore[no-untyped-def]
        settings = app.state.settings
        if request.url.path not in _OPEN_PATHS and settings.api_key is not None:
            if not verify_api_key(request.headers.get("X-API-Key"), settings.api_key):
                return JSONResponse(
                    status_code=401, content={"detail": "invalid or missing API key"}
                )
        if request.method == "POST" and request.url.path in _RATE_LIMITED_PATHS:
            if app.state.rate_limiter is None:
                app.state.rate_limiter = RateLimiter(settings.rate_limit_per_minute)
            client_key = request.client.host if request.client else "unknown"
            if not app.state.rate_limiter.allow(client_key):
                return JSONResponse(status_code=429, content={"detail": "rate limit exceeded"})
        return await call_next(request)

    # Registered after enforce_security so CORS ends up OUTERMOST: Starlette's
    # add_middleware() prepends to the stack, so whichever middleware is added
    # last wraps everything added before it. With CORS outermost, its own
    # preflight handling answers cross-origin OPTIONS requests (which never
    # carry X-API-Key) before enforce_security gets a chance to 401 them, and
    # it still stamps Access-Control-Allow-Origin onto 401/429 responses that
    # enforce_security returns, since those responses pass back out through it.
    # Desktop webview origins: Vite dev server and Tauri's production origin.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:1420",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.post("/search")
    def search(request: SearchRequest) -> SearchResponse:
        try:
            if app.state.deps is None:  # dropped after a DB failure — reconnect now
                _connect_deps(app)
            return run_search(app.state.deps, request.q, request.k, request.lang)
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
    # Exact wording is part of the citation contract: the M6 evals refusal metric
    # requires this sentence verbatim, so it must never carry a [SR ...] tag.
    # REFUSAL_SENTENCE is the single source of truth (retrieval.generation).
    _REFUSAL_TEXT = REFUSAL_SENTENCE

    @app.post("/chat")
    def chat(request: ChatRequest) -> StreamingResponse:
        detected = None if request.lang is not None else detect_language(request.question)
        fts_lang = fts_language(request.lang, detected)
        language = answer_language(request.lang, detected)
        try:
            if app.state.deps is None:
                _connect_deps(app)
            search_response = run_search(app.state.deps, request.question, request.k, fts_lang)
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
        sources = search_response.results
        answer_lang = answer_language_code(request.lang, detected)

        def events() -> Iterator[str]:
            yield _sse(
                "sources",
                {"sources": [s.model_dump(include=_SOURCE_FIELDS) for s in sources]},
            )
            t0 = time.perf_counter()
            if not sources:
                # Nothing to ground an answer in — refuse deterministically without
                # spending a generation call on it (Ollama is never invoked).
                yield _sse("token", {"delta": _REFUSAL_TEXT})
                yield _sse(
                    "done",
                    {
                        "citations": [],
                        "model": settings.chat_model,
                        "duration_ms": int((time.perf_counter() - t0) * 1000),
                    },
                )
                return
            if app.state.client is None:  # deps were injected without a real client
                app.state.client = httpx.Client(timeout=60.0)
            client = app.state.client
            messages = build_messages(request.question, language, sources)
            parts: list[str] = []
            try:
                for kind, delta in stream_chat(
                    client, settings.ollama_base_url, settings.chat_model, messages
                ):
                    if kind == "thinking":
                        yield _sse("thinking", {"delta": delta})
                        continue
                    parts.append(delta)
                    yield _sse("token", {"delta": delta})
            except Exception as error:
                yield _sse("error", {"detail": str(error)})
                return
            citations = extract_citations("".join(parts), sources, answer_lang)
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

    @app.get("/ready")
    def ready() -> JSONResponse:
        # Real dependency probes for orchestration/monitoring; /health above
        # stays a static 200 for liveness. Each check reports False rather
        # than raising, so one down dependency 503s instead of 500ing.
        if app.state.client is None:
            app.state.client = httpx.Client(timeout=60.0)
        settings = app.state.settings
        checks = {
            "postgres": check_postgres(settings),
            "ollama": check_ollama(app.state.client, settings),
            "corpus": check_corpus(settings),
        }
        ready_status = all(checks.values())
        return JSONResponse(
            status_code=200 if ready_status else 503,
            content={"ready": ready_status, "checks": checks},
        )

    @app.get("/ingest/status")
    def get_ingest_status() -> dict:
        return ingest_status(app.state.ingest, app.state.settings.database_url)

    @app.post("/ingest", status_code=202)
    def post_ingest() -> dict[str, str]:
        python = ingestion_python(app.state.settings.ingestion_python)
        if not start_ingest(app.state.ingest, python):
            raise HTTPException(status_code=409, detail="an ingest run is already active")
        return {"status": "started"}

    @app.post("/ingest/stop")
    def post_ingest_stop() -> dict[str, str]:
        if not stop_ingest(app.state.ingest):
            raise HTTPException(status_code=409, detail="no ingest run is active")
        return {"status": "stopping"}

    @app.get("/ingest/progress")
    def ingest_progress() -> StreamingResponse:
        state = app.state.ingest
        database_url = app.state.settings.database_url

        def events() -> Iterator[str]:
            while True:
                with state.lock:
                    running = state.running
                    phase = state.phase if running else None
                current = phase if phase is not None else "embed"
                done, total = phase_progress(current, database_url)
                yield _sse("progress", {"phase": current, "done": done, "total": total})
                if not running:
                    break
                time.sleep(1.0)
            with state.lock:
                error = state.error
            if error is not None:
                yield _sse("error", {"detail": error})
            else:
                yield _sse("done", {"chunks_embedded": embedded_count(database_url)})

        return StreamingResponse(events(), media_type="text/event-stream")

    return app


app = create_app()
