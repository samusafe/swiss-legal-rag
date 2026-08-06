import os

import pytest

from tests.test_embed import chunk_for


def _try_connect():
    import psycopg
    from dotenv import load_dotenv

    load_dotenv()
    url = os.environ.get(
        "DATABASE_URL", "postgresql://rag:rag-local-only@localhost:5432/swiss_legal_rag"
    )
    try:
        return psycopg.connect(url, connect_timeout=2)
    except Exception:
        return None


@pytest.mark.db
@pytest.mark.skipif(_try_connect() is None, reason="local Postgres not reachable")
def test_upsert_resumability_roundtrip() -> None:
    from pgvector.psycopg import register_vector

    from ingestion.embed import SCHEMA_SQL, upsert_chunks

    conn = _try_connect()
    assert conn is not None
    with conn:
        conn.execute(SCHEMA_SQL)
        register_vector(conn)
        chunk = chunk_for("A › B")
        upsert_chunks(conn, [chunk])
        conn.execute("UPDATE chunks SET embedding = %s WHERE eli = %s", ([0.5] * 1024, chunk.eli))
        upsert_chunks(conn, [chunk])  # same text -> embedding preserved
        kept = conn.execute(
            "SELECT embedding IS NOT NULL FROM chunks WHERE eli = %s", (chunk.eli,)
        ).fetchone()
        assert kept[0] is True
        changed = chunk.model_copy(update={"text": "Art. 335c\n1 Neuer Inhalt."})
        upsert_chunks(conn, [changed])  # text change -> embedding reset to NULL
        reset = conn.execute(
            "SELECT embedding IS NULL FROM chunks WHERE eli = %s", (chunk.eli,)
        ).fetchone()
        assert reset[0] is True
        conn.execute("DELETE FROM chunks WHERE eli = %s", (chunk.eli,))
