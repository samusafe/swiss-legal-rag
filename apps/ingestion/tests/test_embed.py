from datetime import date

import httpx
import pytest

from ingestion.embed import embed_texts, embedding_input, ts_config
from ingestion.models import Chunk
from tests.conftest import make_client


def chunk_for(context: str | None) -> Chunk:
    return Chunk(
        sr="220", lang="de", article="335c", eid="art_335_c", context=context,
        heading="nach Ablauf der Probezeit", text="Art. 335c\n1 Inhalt.",
        eli="https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335_c",
        act_name="Code of Obligations", abbrev="OR / CO", version_date=date(2026, 1, 1),
    )


def test_embedding_input_with_breadcrumb() -> None:
    assert embedding_input(chunk_for("A › B")) == "Code of Obligations (OR / CO) — A › B\nArt. 335c\n1 Inhalt."


def test_embedding_input_without_breadcrumb() -> None:
    assert embedding_input(chunk_for(None)) == "Code of Obligations (OR / CO)\nArt. 335c\n1 Inhalt."


@pytest.mark.parametrize(("lang", "config"), [("de", "german"), ("fr", "french"), ("it", "italian")])
def test_ts_config(lang: str, config: str) -> None:
    assert ts_config(lang) == config


def test_ts_config_rejects_unknown() -> None:
    with pytest.raises(RuntimeError, match="rm"):
        ts_config("rm")


def test_embed_texts_batches_and_parses() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"embeddings": [[0.1] * 1024] * len(seen[-1]["input"])})

    client = make_client(handler)
    vectors = embed_texts(client, "http://localhost:11434", "bge-m3", ["a", "b"])
    assert len(vectors) == 2 and len(vectors[0]) == 1024
    assert seen[0]["model"] == "bge-m3" and seen[0]["input"] == ["a", "b"]


def test_embed_texts_fails_loud() -> None:
    client = make_client(lambda request: httpx.Response(500))
    with pytest.raises(RuntimeError, match="Ollama"):
        embed_texts(client, "http://localhost:11434", "bge-m3", ["a"])


def test_load_chunks_rejects_duplicate_keys(tmp_path) -> None:
    from ingestion.embed import load_chunks

    lang_dir = tmp_path / "220"
    lang_dir.mkdir()
    first = chunk_for(None).model_copy(
        update={"article": "220", "eid": "art_221", "part": None}
    )
    second = chunk_for(None).model_copy(
        update={"article": "221", "eid": "art_221", "part": None}
    )
    (lang_dir / "fr.jsonl").write_text(
        f"{first.model_dump_json()}\n{second.model_dump_json()}\n", encoding="utf-8"
    )

    with pytest.raises(
        RuntimeError,
        match=r"duplicate chunk key .*SR 220 de articles 220 and 221",
    ):
        load_chunks(tmp_path)


def _try_connect():
    import psycopg

    url = "postgresql://rag:rag-local-only@localhost:5432/swiss_legal_rag"
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
