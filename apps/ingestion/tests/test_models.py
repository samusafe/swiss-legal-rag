from datetime import date
from pathlib import Path

from ingestion.models import Manifest, ManifestEntry


def make_entry() -> ManifestEntry:
    return ManifestEntry(
        sr="220",
        lang="de",
        act_name="Code of Obligations",
        abbrev="OR / CO",
        version_date=date(2026, 1, 1),
        eli="https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de",
        file_url="https://fedlex.data.admin.ch/filestore/example/de-xml.xml",
    )


def test_manifest_roundtrip(tmp_path: Path) -> None:
    manifest = Manifest(entries=[make_entry()])
    path = tmp_path / "manifest.json"
    manifest.save(path)
    loaded = Manifest.load(path)
    assert loaded == manifest
    assert '"version_date": "2026-01-01"' in path.read_text(encoding="utf-8")


def test_chunk_json_roundtrip() -> None:
    from ingestion.models import Chunk

    chunk = Chunk(
        sr="220",
        lang="de",
        article="335c",
        heading="Kündigungsfristen",
        text="Art. 335c\n1 Beispieltext.",
        eli="https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de#art_335_c",
        act_name="Code of Obligations",
        abbrev="OR / CO",
        version_date=date(2026, 1, 1),
    )
    assert chunk.part is None
    data = chunk.model_dump_json()
    assert '"article":"335c"' in data.replace(" ", "")
    assert Chunk.model_validate_json(data) == chunk
