from datetime import date

import psycopg
from pgvector.psycopg import register_vector
from pydantic import BaseModel

from retrieval.config import Settings

_COLUMNS = "id, sr, lang, article, part, eid, heading, context, text, eli, act_name, abbrev, version_date"
_TS_CONFIGS = {"de": "german", "fr": "french", "it": "italian"}


class ChunkRow(BaseModel):
    id: int
    sr: str
    lang: str
    article: str
    part: int | None
    eid: str
    heading: str | None
    context: str | None
    text: str
    eli: str
    act_name: str
    abbrev: str
    version_date: date


def connect(settings: Settings) -> psycopg.Connection:
    # autocommit: this is a read-only query connection, held for the process
    # lifetime. Without it, one failed query leaves it idle-in-transaction and
    # every later request 503s until the process is restarted.
    # connect_timeout: without it a down/restarting Postgres blocks app startup
    # forever with no error ("Waiting for application startup." hangs silently).
    conn = psycopg.connect(settings.database_url, autocommit=True, connect_timeout=10)
    register_vector(conn)
    return conn


def _rows(cur: psycopg.Cursor) -> list[ChunkRow]:
    assert cur.description is not None
    names = [d.name for d in cur.description]
    rows = [ChunkRow.model_validate(dict(zip(names, row))) for row in cur.fetchall()]
    # DB stores part=0 for whole articles; the API contract uses null.
    return [r.model_copy(update={"part": r.part or None}) for r in rows]


def dense_search(conn: psycopg.Connection, embedding: list[float], k: int) -> list[ChunkRow]:
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {_COLUMNS} FROM chunks WHERE embedding IS NOT NULL "
            "ORDER BY embedding <=> %s::vector LIMIT %s",
            (embedding, k),
        )
        return _rows(cur)


def fts_search(conn: psycopg.Connection, q: str, lang: str, k: int) -> list[ChunkRow]:
    if lang not in _TS_CONFIGS:
        raise ValueError(f"unsupported lang {lang!r}; expected one of {sorted(_TS_CONFIGS)}")
    config = _TS_CONFIGS[lang]
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {_COLUMNS} FROM chunks, websearch_to_tsquery(%s::regconfig, %s) query "
            "WHERE tsv @@ query AND lang = %s ORDER BY ts_rank_cd(tsv, query) DESC LIMIT %s",
            (config, q, lang, k),
        )
        return _rows(cur)


def article_rows(
    conn: psycopg.Connection, sr: str, article: str, lang: str
) -> list[ChunkRow]:
    """All stored parts of one article in one language, in document order."""
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT {_COLUMNS} FROM chunks "
            "WHERE sr = %s AND lower(article) = lower(%s) AND lang = %s "
            "ORDER BY part",
            (sr, article, lang),
        )
        return _rows(cur)


def article_langs(conn: psycopg.Connection, sr: str, article: str) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT DISTINCT lang FROM chunks "
            "WHERE sr = %s AND lower(article) = lower(%s) ORDER BY lang",
            (sr, article),
        )
        return [row[0] for row in cur.fetchall()]
