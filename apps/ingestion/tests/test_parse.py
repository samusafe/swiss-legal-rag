import json
from datetime import date
from pathlib import Path

import pytest

from ingestion.models import Manifest, ManifestEntry
from ingestion.parse import parse_all
from tests.conftest import akn_doc


def manifest_for(tmp_path: Path) -> Manifest:
    entry = ManifestEntry(
        jurisdiction="CH",
        collection="SR",
        number="220",
        lang="de",
        act_name="Code of Obligations",
        abbrev="OR / CO",
        version_date=date(2026, 1, 1),
        source_url="https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de",
        file_url="https://fedlex.data.admin.ch/filestore/example.xml",
        source="fedlex",
    )
    raw = tmp_path / "raw" / "CH" / "220"
    raw.mkdir(parents=True)
    (raw / "de.xml").write_bytes(akn_doc(
        '<article eId="art_1"><num>Art. 1</num>'
        '<paragraph eId="art_1/para_1"><num>1</num><content><p>Inhalt.</p></content></paragraph>'
        "</article>"
    ))
    return Manifest(entries=[entry])


def test_parse_all_writes_jsonl(tmp_path: Path) -> None:
    manifest = manifest_for(tmp_path)
    counts = parse_all(manifest, tmp_path / "raw", tmp_path / "chunks")
    assert counts == {"CH/220/de": 1}
    out = tmp_path / "chunks" / "CH" / "220" / "de.jsonl"
    lines = out.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["article"] == "1"
    assert record["version_date"] == "2026-01-01"
    assert not out.with_suffix(".jsonl.tmp").exists()


def test_parse_all_overwrites_previous_output(tmp_path: Path) -> None:
    manifest = manifest_for(tmp_path)
    out = tmp_path / "chunks" / "CH" / "220" / "de.jsonl"
    out.parent.mkdir(parents=True)
    out.write_text("stale\n", encoding="utf-8")
    parse_all(manifest, tmp_path / "raw", tmp_path / "chunks")
    assert "stale" not in out.read_text(encoding="utf-8")


def test_parse_all_fails_loud_on_missing_xml(tmp_path: Path) -> None:
    manifest = manifest_for(tmp_path)
    (tmp_path / "raw" / "CH" / "220" / "de.xml").unlink()
    with pytest.raises(RuntimeError, match="missing raw XML"):
        parse_all(manifest, tmp_path / "raw", tmp_path / "chunks")


def test_parse_all_dispatches_lexwork_entry(tmp_path: Path) -> None:
    entry = ManifestEntry(
        jurisdiction="SG",
        collection="sGS",
        number="151.2",
        lang="de",
        act_name="Gemeindegesetz",
        abbrev="GG",
        version_date=date(2026, 1, 1),
        source_url="https://www.gesetzessammlung.sg.ch/app/de/texts_of_law/151.2",
        file_url="https://www.gesetzessammlung.sg.ch/api/de/texts_of_law/151.2",
        source="lexwork",
    )
    fixture = Path(__file__).parent / "fixtures" / "lexwork_sample.json"
    raw = tmp_path / "raw" / "SG"
    raw.mkdir(parents=True)
    (raw / "151.2.de.json").write_text(fixture.read_text(encoding="utf-8"), encoding="utf-8")

    manifest = Manifest(entries=[entry])
    counts = parse_all(manifest, tmp_path / "raw", tmp_path / "chunks")

    assert counts == {"SG/151.2/de": 2}
    out = tmp_path / "chunks" / "SG" / "151.2" / "de.jsonl"
    assert out.exists()


def test_parse_all_fails_loud_on_missing_lexwork_json(tmp_path: Path) -> None:
    entry = ManifestEntry(
        jurisdiction="SG",
        collection="sGS",
        number="811.1",
        lang="de",
        act_name="Tax Act",
        abbrev="StG",
        version_date=date(2026, 1, 1),
        source_url="https://www.gesetzessammlung.sg.ch/app/de/texts_of_law/811.1",
        file_url="https://www.gesetzessammlung.sg.ch/api/de/texts_of_law/811.1",
        source="lexwork",
    )
    manifest = Manifest(entries=[entry])
    with pytest.raises(FileNotFoundError):
        parse_all(manifest, tmp_path / "raw", tmp_path / "chunks")


def test_cli_parse_writes_chunks(tmp_path: Path) -> None:
    from ingestion import cli

    manifest = manifest_for(tmp_path)
    manifest.save(tmp_path / "manifest.json")

    cli.main(["parse", "--data-dir", str(tmp_path)])

    out = tmp_path / "chunks" / "CH" / "220" / "de.jsonl"
    assert out.exists()
    assert json.loads(out.read_text(encoding="utf-8").splitlines()[0])["number"] == "220"
