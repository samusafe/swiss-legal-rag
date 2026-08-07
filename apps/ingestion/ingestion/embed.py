import os
from pathlib import Path

import httpx
import psycopg
from dotenv import load_dotenv
from pgvector.psycopg import register_vector

from ingestion.models import Chunk

# Retrieval (apps/retrieval) reads this table; ingestion owns schema and writes.
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS chunks (
    id           bigserial PRIMARY KEY,
    eli          text NOT NULL,
    part         integer NOT NULL DEFAULT 0,
    sr           text NOT NULL,
    lang         text NOT NULL,
    article      text NOT NULL,
    eid          text NOT NULL,
    heading      text,
    context      text,
    act_name     text NOT NULL,
    abbrev       text NOT NULL,
    version_date date NOT NULL,
    text         text NOT NULL,
    embedding    vector(1024),
    tsv          tsvector,
    UNIQUE (eli, part)
);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);
"""

_TS_CONFIGS = {"de": "german", "fr": "french", "it": "italian"}

_INSERT_SQL = """
INSERT INTO chunks (eli, part, sr, lang, article, eid, heading, context,
                    act_name, abbrev, version_date, text, tsv)
VALUES (%(eli)s, %(part)s, %(sr)s, %(lang)s, %(article)s, %(eid)s, %(heading)s, %(context)s,
        %(act_name)s, %(abbrev)s, %(version_date)s, %(text)s,
        to_tsvector(%(ts_config)s::regconfig, coalesce(%(heading)s, '') || ' ' || %(text)s))
"""
# No ON CONFLICT clause: upsert_chunks deletes each act's rows before inserting,
# and _check_no_duplicate_keys already rejects duplicate (eli, part) keys within
# a batch, so every insert here targets a fresh row.


def ts_config(lang: str) -> str:
    config = _TS_CONFIGS.get(lang)
    if config is None:
        raise RuntimeError(f"no text-search config for language: {lang}")
    return config


def embedding_input(act_name: str, abbrev: str, context: str | None, text: str) -> str:
    prefix = f"{act_name} ({abbrev})"
    if context:
        prefix = f"{prefix} — {context}"
    return f"{prefix}\n{text}"


def embed_texts(
    client: httpx.Client, base_url: str, model: str, texts: list[str]
) -> list[list[float]]:
    response = client.post(f"{base_url}/api/embed", json={"model": model, "input": texts})
    if response.status_code != 200:
        raise RuntimeError(
            f"Ollama embed failed (HTTP {response.status_code}) — is `ollama serve` "
            f"running at {base_url} and `{model}` pulled?"
        )
    return response.json()["embeddings"]


def load_chunks(chunks_dir: Path) -> list[Chunk]:
    files = sorted(chunks_dir.glob("*/*.jsonl"))
    if not files:
        raise RuntimeError(f"no chunk files under {chunks_dir} — run `ingest parse` first")
    chunks: list[Chunk] = []
    for file in files:
        for line in file.read_text(encoding="utf-8").splitlines():
            chunks.append(Chunk.model_validate_json(line))
    _check_no_duplicate_keys(chunks)
    return chunks


def _check_no_duplicate_keys(chunks: list[Chunk]) -> None:
    # upsert_chunks has no ON CONFLICT handling, so a duplicate (eli, part) key
    # would otherwise surface as an opaque UNIQUE-violation from Postgres — fail
    # loud here instead, and report every collision at once.
    seen: dict[tuple[str, int], Chunk] = {}
    collisions: list[str] = []
    for chunk in chunks:
        key = (chunk.eli, chunk.part or 0)
        prior = seen.get(key)
        if prior is not None:
            collisions.append(
                f"eli={chunk.eli} part={key[1]}: SR {chunk.sr} {chunk.lang} "
                f"articles {prior.article} and {chunk.article}"
            )
        else:
            seen[key] = chunk
    if collisions:
        raise RuntimeError(
            "duplicate chunk keys — duplicate source eIds in Fedlex XML:\n  "
            + "\n  ".join(collisions)
        )


def upsert_chunks(conn: psycopg.Connection, chunks: list[Chunk]) -> None:
    # Wholesale-refresh every act present in `chunks`: delete its existing rows first,
    # then re-insert the current set, all in one transaction. This makes revoked or
    # renumbered articles disappear atomically instead of accumulating as stale rows
    # that a pure upsert would never remove.
    acts = list(dict.fromkeys(chunk.sr for chunk in chunks))
    with conn.cursor() as cur:
        for sr in acts:
            cur.execute("DELETE FROM chunks WHERE sr = %s", (sr,))
        for chunk in chunks:
            params = chunk.model_dump()
            params["part"] = chunk.part or 0
            params["ts_config"] = ts_config(chunk.lang)
            cur.execute(_INSERT_SQL, params)
    conn.commit()


def embed_pending(
    conn: psycopg.Connection,
    client: httpx.Client,
    base_url: str,
    model: str,
    batch_size: int = 16,
) -> int:
    rows = conn.execute(
        "SELECT id, act_name, abbrev, context, text FROM chunks WHERE embedding IS NULL ORDER BY id"
    ).fetchall()
    done = 0
    for start in range(0, len(rows), batch_size):
        batch = rows[start : start + batch_size]
        texts = [embedding_input(r[1], r[2], r[3], r[4]) for r in batch]
        vectors = embed_texts(client, base_url, model, texts)
        with conn.cursor() as cur:
            for row, vector in zip(batch, vectors, strict=True):
                cur.execute("UPDATE chunks SET embedding = %s WHERE id = %s", (vector, row[0]))
        conn.commit()  # per-batch commit keeps the run resumable after interruption
        done += len(batch)
        print(f"embedded {done}/{len(rows)}", flush=True)
    return done


def run_embed(data_dir: Path) -> None:
    load_dotenv()  # repo-root .env, same names as .env.example
    database_url = os.environ.get(
        "DATABASE_URL", "postgresql://rag:rag-local-only@localhost:5432/swiss_legal_rag"
    )
    base_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
    model = os.environ.get("EMBEDDING_MODEL", "bge-m3")
    chunks = load_chunks(data_dir / "chunks")
    with psycopg.connect(database_url) as conn:
        conn.execute(SCHEMA_SQL)
        conn.commit()
        register_vector(conn)
        upsert_chunks(conn, chunks)
        print(f"upserted {len(chunks)} chunks", flush=True)
        with httpx.Client(timeout=300.0) as client:
            done = embed_pending(conn, client, base_url, model)
        remaining = conn.execute("SELECT count(*) FROM chunks WHERE embedding IS NULL").fetchone()
        assert remaining is not None
        print(f"embedded {done} new vectors; {remaining[0]} still pending", flush=True)
