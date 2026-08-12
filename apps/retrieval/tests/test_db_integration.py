from datetime import date

import httpx
import pytest

from retrieval.embeddings import embed_query
from tests.conftest import make_client


def test_embed_query_returns_single_vector() -> None:
    client = make_client(
        lambda request: httpx.Response(200, json={"embeddings": [[0.2] * 1024]})
    )
    assert len(embed_query(client, "http://localhost:11434", "bge-m3", "frage")) == 1024


def test_embed_query_fails_loud() -> None:
    client = make_client(lambda request: httpx.Response(503))
    with pytest.raises(RuntimeError, match="Ollama"):
        embed_query(client, "http://localhost:11434", "bge-m3", "frage")


def test_embed_query_fails_loud_when_ollama_unreachable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    client = make_client(handler)
    with pytest.raises(RuntimeError, match="Ollama unreachable"):
        embed_query(client, "http://localhost:11434", "bge-m3", "frage")


def _try_connect():
    import psycopg

    from retrieval.config import Settings

    settings = Settings.from_env()
    try:
        return psycopg.connect(settings.database_url, connect_timeout=2)
    except Exception:
        return None


@pytest.mark.db
@pytest.mark.skipif(_try_connect() is None, reason="local Postgres not reachable")
def test_dense_and_fts_search() -> None:
    from retrieval.config import Settings
    from retrieval.db import connect, dense_search, fts_search

    settings = Settings.from_env()
    conn = connect(settings)
    try:
        # Insert 3 synthetic test rows with distinct texts and embeddings
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chunks (sr, lang, article, part, eid, heading, context, text, eli, act_name, abbrev, version_date, embedding, tsv)
                VALUES
                    (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::vector, to_tsvector('german', %s)),
                    (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::vector, to_tsvector('german', %s)),
                    (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::vector, to_tsvector('german', %s))
                """
                , (
                    "220", "de", "335a", 0, "art_335_a", "Kündigungsfrist", None, "syntheticmarker Kündigungsfrist Arbeitsverhältnis", "https://test.eli/1", "Test Act", "TA", date(2026, 1, 1), [0.1] + [0.0] * 1023, "syntheticmarker Kündigungsfrist Arbeitsverhältnis",
                    "220", "de", "335b", 0, "art_335_b", "Mietvertrag", None, "Mietvertrag Wohnung", "https://test.eli/2", "Test Act", "TA", date(2026, 1, 1), [0.0, 0.2] + [0.0] * 1022, "Mietvertrag Wohnung",
                    "220", "de", "335c", 0, "art_335_c", "Datenschutz", None, "Datenschutz Personendaten", "https://test.eli/3", "Test Act", "TA", date(2026, 1, 1), [0.0, 0.0, 0.9] + [0.0] * 1021, "Datenschutz Personendaten",
                )
            )
            conn.commit()

        # Test dense_search returns nearest first
        results = dense_search(conn, [0.1] + [0.0] * 1023, 3)
        assert len(results) == 3
        assert results[0].text == "syntheticmarker Kündigungsfrist Arbeitsverhältnis"

        # Test fts_search returns matching row first
        results = fts_search(conn, "syntheticmarker", "de", 5)
        assert len(results) >= 1
        assert results[0].text == "syntheticmarker Kündigungsfrist Arbeitsverhältnis"
    finally:
        # Cleanup: delete test rows on the same live connection before closing
        with conn.cursor() as cur:
            cur.execute("DELETE FROM chunks WHERE eli IN (%s, %s, %s)", ("https://test.eli/1", "https://test.eli/2", "https://test.eli/3"))
            conn.commit()
        conn.close()


@pytest.mark.db
@pytest.mark.skipif(_try_connect() is None, reason="local Postgres not reachable")
def test_article_rows_and_langs() -> None:
    from retrieval.config import Settings
    from retrieval.db import article_langs, article_rows, connect

    settings = Settings.from_env()
    conn = connect(settings)
    try:
        # Two parts in "de", one part in "fr" — exercises both part ordering
        # and cross-language availability in a single article.
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chunks (sr, lang, article, part, eid, heading, context, text, eli, act_name, abbrev, version_date)
                VALUES
                    (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s),
                    (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s),
                    (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """
                , (
                    "220", "de", "335x", 2, "art_335_x", "Probezeit", None, "syntheticmarker part two", "https://test.eli/4", "Test Act", "TA", date(2026, 1, 1),
                    "220", "de", "335x", 1, "art_335_x", "Probezeit", None, "syntheticmarker part one", "https://test.eli/5", "Test Act", "TA", date(2026, 1, 1),
                    "220", "fr", "335x", 1, "art_335_x", "Periode d'essai", None, "syntheticmarker partie une", "https://test.eli/6", "Test Act", "TA", date(2026, 1, 1),
                )
            )
            conn.commit()

        rows = article_rows(conn, "220", "335x", "de")
        assert [r.text for r in rows] == ["syntheticmarker part one", "syntheticmarker part two"]

        langs = article_langs(conn, "220", "335x")
        assert langs == ["de", "fr"]
    finally:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM chunks WHERE eli IN (%s, %s, %s)",
                ("https://test.eli/4", "https://test.eli/5", "https://test.eli/6"),
            )
            conn.commit()
        conn.close()
