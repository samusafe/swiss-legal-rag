from datetime import date
from pathlib import Path
from unittest.mock import MagicMock

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


def test_embedding_input_includes_act_and_context() -> None:
    text = embedding_input("Code of Obligations", "OR / CO", "A › B", "Art. 335c\n1 Inhalt.")
    assert text == "Code of Obligations (OR / CO) — A › B\nArt. 335c\n1 Inhalt."


def test_embedding_input_without_context() -> None:
    text = embedding_input("Code of Obligations", "OR / CO", None, "Art. 335c\n1 Inhalt.")
    assert text == "Code of Obligations (OR / CO)\nArt. 335c\n1 Inhalt."


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


def test_load_chunks_reports_all_collisions(tmp_path: Path) -> None:
    from ingestion.embed import load_chunks

    lang_dir = tmp_path / "de"
    lang_dir.mkdir()
    # Create 4 chunks forming 2 colliding (eli, part) pairs
    chunk1 = chunk_for(None).model_copy(
        update={"article": "335", "eid": "art_335", "eli": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335"}
    )
    chunk2 = chunk_for(None).model_copy(
        update={"article": "335a", "eid": "art_335", "eli": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335"}  # collision with chunk1
    )
    chunk3 = chunk_for(None).model_copy(
        update={"article": "335b", "eid": "art_335b", "eli": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335b"}
    )
    chunk4 = chunk_for(None).model_copy(
        update={"article": "335c", "eid": "art_335b", "eli": "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335b"}  # collision with chunk3
    )
    (lang_dir / "de.jsonl").write_text(
        f"{chunk1.model_dump_json()}\n{chunk2.model_dump_json()}\n{chunk3.model_dump_json()}\n{chunk4.model_dump_json()}\n",
        encoding="utf-8"
    )

    with pytest.raises(RuntimeError) as excinfo:
        load_chunks(tmp_path)
    message = str(excinfo.value)
    assert "duplicate chunk keys" in message
    assert message.count("articles") == 2  # both collisions listed, not just the first


def _mock_conn() -> tuple[MagicMock, MagicMock]:
    cursor = MagicMock()
    conn = MagicMock()
    conn.cursor.return_value.__enter__.return_value = cursor
    return conn, cursor


def test_upsert_chunks_leaves_unchanged_row_untouched() -> None:
    from ingestion.embed import upsert_chunks

    conn, cursor = _mock_conn()
    chunk = chunk_for(None)
    cursor.fetchall.return_value = [(chunk.eli, 0, chunk.sr, chunk.text)]

    upsert_chunks(conn, [chunk])

    mutating = [
        call for call in cursor.execute.call_args_list
        if not call.args[0].strip().startswith("SELECT")
    ]
    # text is identical to what's stored — no DELETE/UPDATE/INSERT touches this
    # row, so its embedding (whatever it is) is left exactly as-is.
    assert mutating == []
    conn.commit.assert_called_once()


def test_upsert_chunks_updates_changed_text_and_resets_embedding() -> None:
    from ingestion.embed import upsert_chunks

    conn, cursor = _mock_conn()
    chunk = chunk_for(None).model_copy(update={"text": "Art. 335c\n1 Amended."})
    cursor.fetchall.return_value = [(chunk.eli, 0, chunk.sr, "Art. 335c\n1 Inhalt.")]

    upsert_chunks(conn, [chunk])

    update_calls = [
        call for call in cursor.execute.call_args_list
        if call.args[0].strip().startswith("UPDATE")
    ]
    assert len(update_calls) == 1
    sql, params = update_calls[0].args
    assert "embedding = NULL" in sql
    assert params["eli"] == chunk.eli
    assert params["part"] == 0
    assert params["text"] == chunk.text
    conn.commit.assert_called_once()


def test_upsert_chunks_deletes_vanished_key_only() -> None:
    from ingestion.embed import upsert_chunks

    conn, cursor = _mock_conn()
    kept = chunk_for(None)
    vanished_eli = kept.eli.replace("art_335_c", "art_336")
    cursor.fetchall.return_value = [
        (kept.eli, 0, kept.sr, kept.text),
        (vanished_eli, 0, kept.sr, "Art. 336\n1 Repealed content."),
    ]

    upsert_chunks(conn, [kept])

    delete_calls = [
        call for call in cursor.execute.call_args_list
        if call.args[0].strip().startswith("DELETE")
    ]
    assert len(delete_calls) == 1
    sql, params = delete_calls[0].args
    assert params == (vanished_eli, 0)
    conn.commit.assert_called_once()


def test_upsert_chunks_inserts_new_row() -> None:
    from ingestion.embed import upsert_chunks

    conn, cursor = _mock_conn()
    cursor.fetchall.return_value = []
    chunk = chunk_for(None)

    upsert_chunks(conn, [chunk])

    insert_calls = [
        call for call in cursor.execute.call_args_list
        if call.args[0].strip().startswith("INSERT")
    ]
    assert len(insert_calls) == 1
    sql, params = insert_calls[0].args
    assert "embedding" not in sql  # column omitted entirely -> stays NULL
    assert params["eli"] == chunk.eli
    assert params["part"] == 0
    conn.commit.assert_called_once()


def test_upsert_chunks_selective_changes_in_one_transaction() -> None:
    from ingestion.embed import upsert_chunks

    conn, cursor = _mock_conn()

    unchanged = chunk_for(None)
    changed = chunk_for(None).model_copy(
        update={
            "article": "335a",
            "eid": "art_335a",
            "eli": unchanged.eli.replace("335_c", "335_a"),
            "text": "Art. 335a\n1 New wording.",
        }
    )
    new_chunk = chunk_for(None).model_copy(
        update={
            "sr": "221",
            "article": "1",
            "eid": "art_1",
            "eli": "https://www.fedlex.admin.ch/eli/cc/other/de#art_1",
        }
    )
    vanished_eli = unchanged.eli.replace("335_c", "336")

    cursor.fetchall.return_value = [
        (unchanged.eli, 0, unchanged.sr, unchanged.text),
        (changed.eli, 0, changed.sr, "Art. 335a\n1 Old wording."),
        (vanished_eli, 0, unchanged.sr, "Art. 336\n1 Repealed."),
    ]

    upsert_chunks(conn, [unchanged, changed, new_chunk])

    calls = cursor.execute.call_args_list
    select_idx = next(
        i for i, call in enumerate(calls) if call.args[0].strip().startswith("SELECT")
    )
    mutation_idxs = [i for i in range(len(calls)) if i != select_idx]
    # the existing-state lookup happens before any mutation, and every mutation
    # (across both acts) lands in the same transaction as a single commit
    assert mutation_idxs and select_idx < min(mutation_idxs)

    kinds = {calls[i].args[0].strip().split()[0] for i in mutation_idxs}
    assert kinds == {"DELETE", "UPDATE", "INSERT"}
    conn.commit.assert_called_once()

    select_call = calls[select_idx]
    assert set(select_call.args[1][0]) == {"220", "221"}


