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
def test_upsert_chunks_incrementally_refreshes_an_act() -> None:
    # `upsert_chunks` is incremental, keyed by content hash (see ingestion/embed.py):
    # a rerun removes stale articles (revoked/renumbered) via a targeted delete,
    # but leaves an unchanged article's row — and its embedding — untouched. Only
    # rows whose text actually changed are updated and re-embedded.
    from pgvector.psycopg import register_vector

    from ingestion.embed import SCHEMA_SQL, upsert_chunks

    conn = _try_connect()
    assert conn is not None
    with conn:
        conn.execute(SCHEMA_SQL)
        register_vector(conn)
        # Use a synthetic SR absent from corpus.yaml so this test's DELETE FROM
        # chunks WHERE eli = %s AND part = %s can never touch real ingested rows
        # (e.g. SR 220, the real Code of Obligations) if run against the dev DB.
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

        # rerun with only `kept`, text unchanged: `stale`'s row (a revoked/renumbered
        # article) is gone, but `kept`'s embedding survives since its text didn't change.
        upsert_chunks(conn, [kept])

        rows = conn.execute(
            "SELECT eli, embedding IS NULL FROM chunks WHERE sr = %s", (kept.sr,)
        ).fetchall()
        assert {r[0] for r in rows} == {kept.eli}
        assert rows[0][1] is False

        # rerun again with `kept`'s text changed: its row is updated and the
        # embedding is reset to NULL so embed_pending re-embeds it.
        changed = kept.model_copy(update={"text": kept.text + " Amended."})
        upsert_chunks(conn, [changed])

        rows = conn.execute(
            "SELECT eli, embedding IS NULL, text FROM chunks WHERE sr = %s", (kept.sr,)
        ).fetchall()
        assert rows[0][1] is True
        assert rows[0][2] == changed.text

        conn.execute("DELETE FROM chunks WHERE sr = %s", (kept.sr,))
