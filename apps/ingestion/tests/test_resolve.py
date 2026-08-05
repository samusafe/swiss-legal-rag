from datetime import date
from pathlib import Path

import httpx

from ingestion.corpus import Act, CorpusConfig
from ingestion.resolve import resolve_corpus
from tests.conftest import make_client, sparql_response, sparql_row


def test_resolve_corpus_builds_manifest() -> None:
    base = "https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/27/317_321_377"
    rows = [
        sparql_row("DEU", "2026-01-01", f"{base}/20260101/de/xml/a-de.xml"),
        sparql_row("FRA", "2026-01-01", f"{base}/20260101/fr/xml/a-fr.xml"),
        sparql_row("ITA", "2026-01-01", f"{base}/20260101/it/xml/a-it.xml"),
    ]
    client = make_client(lambda request: httpx.Response(200, json=sparql_response(rows)))
    corpus = CorpusConfig(
        languages=["de", "fr", "it"],
        acts=[Act(sr="220", name="Code of Obligations", abbrev="OR / CO")],
    )
    sleeps: list[float] = []

    manifest = resolve_corpus(
        corpus, client, today=date(2026, 8, 5), sleep=sleeps.append
    )

    assert len(manifest.entries) == 3
    entry = manifest.entries[0]
    assert (entry.sr, entry.lang) == ("220", "de")
    assert entry.act_name == "Code of Obligations"
    assert entry.eli == "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de"
    assert entry.version_date == date(2026, 1, 1)
    # single act -> no inter-act sleep needed
    assert sleeps == []


def test_resolve_corpus_sleeps_between_acts(sparql_client: httpx.Client) -> None:
    corpus = CorpusConfig(
        languages=["de", "fr", "it"],
        acts=[
            Act(sr="220", name="Code of Obligations", abbrev="OR / CO"),
            Act(sr="210", name="Civil Code", abbrev="ZGB / CC"),
        ],
    )
    sleeps: list[float] = []

    manifest = resolve_corpus(
        corpus, sparql_client, today=date(2026, 8, 5), sleep=sleeps.append
    )

    assert sleeps == [1.0]
    assert len(manifest.entries) == 6


def test_cli_resolve_writes_manifest(tmp_path: Path, monkeypatch) -> None:
    from ingestion import cli
    from ingestion.models import Manifest as ManifestModel

    base = "https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/27/317_321_377"
    rows = [
        sparql_row("DEU", "2026-01-01", f"{base}/20260101/de/xml/a-de.xml"),
        sparql_row("FRA", "2026-01-01", f"{base}/20260101/fr/xml/a-fr.xml"),
        sparql_row("ITA", "2026-01-01", f"{base}/20260101/it/xml/a-it.xml"),
    ]
    client = make_client(lambda request: httpx.Response(200, json=sparql_response(rows)))
    monkeypatch.setattr(cli, "_make_client", lambda: client)

    corpus_file = tmp_path / "corpus.yaml"
    corpus_file.write_text(
        "languages: [de, fr, it]\n"
        "acts:\n"
        "  - sr: \"220\"\n"
        "    name: Code of Obligations\n"
        "    abbrev: OR / CO\n",
        encoding="utf-8",
    )

    cli.main(
        ["resolve", "--corpus", str(corpus_file), "--data-dir", str(tmp_path / "data")]
    )

    manifest = ManifestModel.load(tmp_path / "data" / "manifest.json")
    assert len(manifest.entries) == 3
