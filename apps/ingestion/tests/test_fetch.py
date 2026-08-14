import json
from datetime import date
from pathlib import Path

import httpx
import pytest

from ingestion.fetch import fetch_all
from ingestion.models import Manifest, ManifestEntry
from tests.conftest import make_client


def make_manifest() -> Manifest:
    def entry(number: str, lang: str) -> ManifestEntry:
        return ManifestEntry(
            jurisdiction="CH",
            collection="SR",
            number=number,
            lang=lang,
            act_name="Code of Obligations",
            abbrev="OR / CO",
            version_date=date(2026, 1, 1),
            source_url=f"https://www.fedlex.admin.ch/eli/cc/27/317_321_377/{lang}",
            file_url=f"https://fedlex.data.admin.ch/filestore/x/{number}-{lang}.xml",
            source="fedlex",
        )

    return Manifest(entries=[entry("220", "de"), entry("220", "fr")])


def test_fetch_all_downloads_and_caches(tmp_path: Path) -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, content=b"<akomaNtoso/>")

    client = make_client(handler)
    sleeps: list[float] = []

    downloaded = fetch_all(make_manifest(), client, tmp_path, sleep=sleeps.append)

    assert [p.relative_to(tmp_path).as_posix() for p in downloaded] == [
        "CH/220/de.xml",
        "CH/220/fr.xml",
    ]
    assert (tmp_path / "CH" / "220" / "de.xml").read_bytes() == b"<akomaNtoso/>"
    assert len(requested) == 2
    assert sleeps == [1.0]  # one sleep between two downloads

    # second run: everything cached, no requests, no sleeps
    requested.clear()
    sleeps.clear()
    downloaded = fetch_all(make_manifest(), client, tmp_path, sleep=sleeps.append)
    assert downloaded == []
    assert requested == []
    assert sleeps == []


def test_fetch_all_raises_on_http_error(tmp_path: Path) -> None:
    client = make_client(lambda request: httpx.Response(404))
    with pytest.raises(RuntimeError, match="404"):
        fetch_all(make_manifest(), client, tmp_path, sleep=lambda s: None)


def test_fetch_all_redownloads_when_version_date_changes(tmp_path: Path) -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, content=b"<akomaNtoso/>")

    client = make_client(handler)
    manifest = make_manifest()
    fetch_all(manifest, client, tmp_path, sleep=lambda s: None)
    assert len(requested) == 2

    updated = manifest.model_copy(
        update={
            "entries": [
                e.model_copy(update={"version_date": date(2026, 2, 1)}) if e.lang == "de" else e
                for e in manifest.entries
            ]
        }
    )
    requested.clear()
    downloaded = fetch_all(updated, client, tmp_path, sleep=lambda s: None)
    assert [p.relative_to(tmp_path).as_posix() for p in downloaded] == ["CH/220/de.xml"]
    assert len(requested) == 1


def test_fetch_all_redownloads_when_url_changes(tmp_path: Path) -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, content=b"<akomaNtoso/>")

    client = make_client(handler)
    manifest = make_manifest()
    fetch_all(manifest, client, tmp_path, sleep=lambda s: None)

    new_url = "https://fedlex.data.admin.ch/filestore/x/220-de-v2.xml"
    updated = manifest.model_copy(
        update={
            "entries": [
                e.model_copy(update={"file_url": new_url}) if e.lang == "de" else e
                for e in manifest.entries
            ]
        }
    )
    requested.clear()
    downloaded = fetch_all(updated, client, tmp_path, sleep=lambda s: None)
    assert [p.relative_to(tmp_path).as_posix() for p in downloaded] == ["CH/220/de.xml"]
    assert requested == [new_url]


def test_fetch_all_writes_fetch_meta_sidecar(tmp_path: Path) -> None:
    client = make_client(lambda request: httpx.Response(200, content=b"<akomaNtoso/>"))
    fetch_all(make_manifest(), client, tmp_path, sleep=lambda s: None)
    meta = json.loads((tmp_path / "CH" / "220" / "fetch-meta.json").read_text(encoding="utf-8"))
    assert meta["de"]["version_date"] == "2026-01-01"
    assert meta["de"]["file_url"] == "https://fedlex.data.admin.ch/filestore/x/220-de.xml"


def test_fetch_all_redownloads_when_sidecar_missing(tmp_path: Path) -> None:
    # Pre-existing .xml from before fetch-meta.json was introduced (or a manually
    # dropped file) must never be trusted just because it happens to be on disk.
    (tmp_path / "CH" / "220").mkdir(parents=True)
    (tmp_path / "CH" / "220" / "de.xml").write_bytes(b"<akomaNtoso/>")
    (tmp_path / "CH" / "220" / "fr.xml").write_bytes(b"<akomaNtoso/>")

    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, content=b"<akomaNtoso/>")

    client = make_client(handler)
    downloaded = fetch_all(make_manifest(), client, tmp_path, sleep=lambda s: None)

    assert [p.relative_to(tmp_path).as_posix() for p in downloaded] == [
        "CH/220/de.xml",
        "CH/220/fr.xml",
    ]
    assert len(requested) == 2
    assert (tmp_path / "CH" / "220" / "fetch-meta.json").exists()


def test_fetch_all_rejects_untrusted_host(tmp_path: Path) -> None:
    manifest = Manifest(
        entries=[
            ManifestEntry(
                jurisdiction="CH",
                collection="SR",
                number="220",
                lang="de",
                act_name="Code of Obligations",
                abbrev="OR / CO",
                version_date=date(2026, 1, 1),
                source_url="https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de",
                file_url="https://evil.example.com/payload.xml",
                source="fedlex",
            )
        ]
    )
    client = make_client(lambda request: httpx.Response(200, content=b"whatever"))
    with pytest.raises(RuntimeError, match="untrusted host"):
        fetch_all(manifest, client, tmp_path, sleep=lambda s: None)
    assert not (tmp_path / "CH" / "220" / "de.xml").exists()


def test_fetch_all_enforces_download_size_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import ingestion.fetch as fetch_module

    monkeypatch.setattr(fetch_module, "MAX_DOWNLOAD_BYTES", 10)
    client = make_client(lambda request: httpx.Response(200, content=b"x" * 100))
    with pytest.raises(RuntimeError, match="byte cap"):
        fetch_all(make_manifest(), client, tmp_path, sleep=lambda s: None)
    assert not (tmp_path / "CH" / "220" / "de.xml").exists()
    assert not (tmp_path / "CH" / "220" / "de.xml.tmp").exists()


def test_fetch_all_leaves_no_partial_file_on_transport_error(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadError("connection dropped", request=request)

    client = make_client(handler)
    with pytest.raises(httpx.ReadError):
        fetch_all(make_manifest(), client, tmp_path, sleep=lambda s: None)
    assert not (tmp_path / "CH" / "220" / "de.xml").exists()
    assert not (tmp_path / "CH" / "220" / "de.xml.tmp").exists()


def _lexwork_manifest() -> Manifest:
    return Manifest(
        entries=[
            ManifestEntry(
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
        ]
    )


def test_fetch_all_raises_when_lexwork_json_missing(tmp_path: Path) -> None:
    client = make_client(lambda request: httpx.Response(200, content=b"unused"))
    with pytest.raises(RuntimeError, match="missing cached LexWork JSON"):
        fetch_all(_lexwork_manifest(), client, tmp_path, sleep=lambda s: None)


def test_fetch_all_accepts_cached_lexwork_json(tmp_path: Path) -> None:
    cached = tmp_path / "SG" / "811.1.de.json"
    cached.parent.mkdir(parents=True)
    cached.write_text('{"text_of_law": {}}', encoding="utf-8")
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, content=b"unused")

    client = make_client(handler)
    downloaded = fetch_all(_lexwork_manifest(), client, tmp_path, sleep=lambda s: None)
    assert downloaded == []
    assert requested == []  # never re-downloaded; JSON was written by resolve
