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
    jurisdiction text NOT NULL,
    collection   text NOT NULL,
    number       text NOT NULL,
    lang         text NOT NULL,
    article      text NOT NULL,
    part         integer NOT NULL DEFAULT 0,
    eid          text NOT NULL,
    heading      text,
    context      text,
    text         text NOT NULL,
    source_url   text NOT NULL,
    act_name     text NOT NULL,
    abbrev       text NOT NULL,
    version_date date NOT NULL,
    embedding    vector(1024),
    tsv          tsvector,
    UNIQUE (jurisdiction, number, lang, eid, part)
);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);
"""

_TS_CONFIGS = {"de": "german", "fr": "french", "it": "italian"}

_INSERT_SQL = """
INSERT INTO chunks (jurisdiction, collection, number, source_url, part, lang, article, eid,
                    heading, context, act_name, abbrev, version_date, text, tsv)
VALUES (%(jurisdiction)s, %(collection)s, %(number)s, %(source_url)s, %(part)s, %(lang)s,
        %(article)s, %(eid)s, %(heading)s, %(context)s, %(act_name)s, %(abbrev)s,
        %(version_date)s, %(text)s,
        to_tsvector(%(ts_config)s::regconfig, coalesce(%(heading)s, '') || ' ' || %(text)s))
"""
# No ON CONFLICT clause: upsert_chunks only reaches this INSERT for
# (jurisdiction, number, lang, eid, part) keys it already confirmed are absent from the
# existing-rows lookup, and _check_no_duplicate_keys already rejects duplicate keys within
# a batch, so every insert here targets a fresh row.

_UPDATE_SQL = """
UPDATE chunks
SET collection = %(collection)s, source_url = %(source_url)s, article = %(article)s,
    heading = %(heading)s, context = %(context)s, act_name = %(act_name)s,
    abbrev = %(abbrev)s, version_date = %(version_date)s, text = %(text)s,
    tsv = to_tsvector(%(ts_config)s::regconfig, coalesce(%(heading)s, '') || ' ' || %(text)s),
    embedding = NULL
WHERE jurisdiction = %(jurisdiction)s AND number = %(number)s AND lang = %(lang)s
  AND eid = %(eid)s AND part = %(part)s
"""
# Only reached when the incoming text differs from what's stored, so the old
# embedding is now stale — reset it to NULL so embed_pending re-embeds this row.

_DELETE_SQL = (
    "DELETE FROM chunks WHERE jurisdiction = %s AND number = %s AND lang = %s "
    "AND eid = %s AND part = %s"
)

_SELECT_EXISTING_SQL = (
    "SELECT jurisdiction, number, lang, eid, part, text FROM chunks "
    "WHERE (jurisdiction || ':' || number) = ANY(%s)"
)


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
    files = sorted(chunks_dir.glob("*/*/*.jsonl"))
    if not files:
        raise RuntimeError(f"no chunk files under {chunks_dir} — run `ingest parse` first")
    chunks: list[Chunk] = []
    for file in files:
        for line in file.read_text(encoding="utf-8").splitlines():
            chunks.append(Chunk.model_validate_json(line))
    _check_no_duplicate_keys(chunks)
    return chunks


def _check_no_duplicate_keys(chunks: list[Chunk]) -> None:
    # upsert_chunks has no ON CONFLICT handling, so a duplicate
    # (jurisdiction, number, lang, eid, part) key would otherwise surface as an opaque
    # UNIQUE-violation from Postgres — fail loud here instead, report every collision at once.
    seen: dict[tuple[str, str, str, str, int], Chunk] = {}
    collisions: list[str] = []
    for chunk in chunks:
        key = (chunk.jurisdiction, chunk.number, chunk.lang, chunk.eid, chunk.part or 0)
        prior = seen.get(key)
        if prior is not None:
            collisions.append(
                f"source_url={chunk.source_url} part={key[4]}: "
                f"{chunk.collection} {chunk.number} {chunk.lang} "
                f"articles {prior.article} and {chunk.article}"
            )
        else:
            seen[key] = chunk
    if collisions:
        raise RuntimeError(
            "duplicate chunk keys — duplicate source eIds within a collection/number:\n  "
            + "\n  ".join(collisions)
        )


def group_by_act(chunks: list[Chunk]) -> dict[tuple[str, str], list[Chunk]]:
    groups: dict[tuple[str, str], list[Chunk]] = {}
    for chunk in chunks:
        groups.setdefault((chunk.jurisdiction, chunk.number), []).append(chunk)
    return groups


def upsert_chunks(conn: psycopg.Connection, chunks: list[Chunk]) -> None:
    # Incremental upsert keyed by content hash — compared here as the raw text
    # itself (UTF-8), which is simpler and just as correct as hashing it. For
    # each act present in `chunks`:
    #   - (jurisdiction, number, lang, eid, part) keys no longer in the incoming set are
    #     deleted (revoked or renumbered articles), instead of an act-wide wipe;
    #   - keys present in both, whose text changed, are updated and their
    #     embedding is reset to NULL for embed_pending to re-embed;
    #   - keys present in both with identical text are left untouched, so an
    #     unchanged article keeps its existing embedding;
    #   - keys with no existing row are inserted with embedding NULL.
    # All of this runs in one transaction, so a crash mid-run leaves the
    # previously committed state intact — same guarantee as before.
    groups = group_by_act(chunks)
    act_keys = [f"{jurisdiction}:{number}" for jurisdiction, number in groups]

    with conn.cursor() as cur:
        cur.execute(_SELECT_EXISTING_SQL, (act_keys,))
        existing: dict[tuple[str, str, str, str, int], str] = {
            (jurisdiction, number, lang, eid, part): text
            for jurisdiction, number, lang, eid, part, text in cur.fetchall()
        }

        for (jurisdiction, number), act_chunks in groups.items():
            incoming_keys = {
                (chunk.jurisdiction, chunk.number, chunk.lang, chunk.eid, chunk.part or 0)
                for chunk in act_chunks
            }
            stale_keys = [
                key
                for key in existing
                if key[0] == jurisdiction and key[1] == number and key not in incoming_keys
            ]
            for stale_key in stale_keys:
                cur.execute(_DELETE_SQL, stale_key)

        for chunk in chunks:
            key = (chunk.jurisdiction, chunk.number, chunk.lang, chunk.eid, chunk.part or 0)
            params = chunk.model_dump()
            params["part"] = chunk.part or 0
            params["ts_config"] = ts_config(chunk.lang)
            prior_text = existing.get(key)
            if prior_text is None:
                cur.execute(_INSERT_SQL, params)
            elif prior_text != chunk.text:
                cur.execute(_UPDATE_SQL, params)
            # else: text unchanged — leave row (and its embedding) untouched
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
