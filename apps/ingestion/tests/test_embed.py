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


def test_load_chunks_reports_all_collisions(tmp_path) -> None:
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


