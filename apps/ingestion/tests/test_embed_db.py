import os
from typing import Any

import pytest

from tests.test_embed import chunk_for


def _try_connect() -> Any:
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
def test_upsert_chunks_wholesale_refreshes_an_act() -> None:
    # `upsert_chunks` now deletes an act's existing rows before re-inserting the
    # current set (see ingestion/embed.py), so a rerun both removes stale articles
    # (revoked/renumbered) and resets embeddings for the whole act, even when a
    # chunk's text is unchanged — this trades the old row-level resumability
    # optimization for a guarantee that stale content never lingers (README).
    from pgvector.psycopg import register_vector

    from ingestion.embed import SCHEMA_SQL, upsert_chunks

    conn = _try_connect()
    assert conn is not None
    with conn:
        conn.execute(SCHEMA_SQL)
        register_vector(conn)
        # Use a synthetic SR absent from corpus.yaml so this test's DELETE FROM
        # chunks WHERE sr = %s can never touch real ingested rows (e.g. SR 220,
        # the real Code of Obligations) if run against the dev DB.
        kept = chunk_for("A › B").model_copy(update={"sr": "999.999"})
        stale = kept.model_copy(
            update={
                "article": "336",
                "eid": "art_336",
                "eli": kept.eli.replace("335_c", "336"),
            }
        )
        upsert_chunks(conn, [kept, stale])
        conn.execute("UPDATE chunks SET embedding = %s WHERE eli = %s", ([0.5] * 1024, kept.eli))

        # rerun with only `kept`: `stale`'s row (a revoked/renumbered article) is
        # gone, and `kept`'s embedding is reset despite its text being unchanged.
        upsert_chunks(conn, [kept])

        rows = conn.execute(
            "SELECT eli, embedding IS NULL FROM chunks WHERE sr = %s", (kept.sr,)
        ).fetchall()
        assert {r[0] for r in rows} == {kept.eli}
        assert rows[0][1] is True
        conn.execute("DELETE FROM chunks WHERE sr = %s", (kept.sr,))
