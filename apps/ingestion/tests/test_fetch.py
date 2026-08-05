from datetime import date
from pathlib import Path

import httpx
import pytest

from ingestion.fetch import fetch_all
from ingestion.models import Manifest, ManifestEntry
from tests.conftest import make_client


def make_manifest() -> Manifest:
    def entry(sr: str, lang: str) -> ManifestEntry:
        return ManifestEntry(
            sr=sr,
            lang=lang,
            act_name="Code of Obligations",
            abbrev="OR / CO",
            version_date=date(2026, 1, 1),
            eli=f"https://www.fedlex.admin.ch/eli/cc/27/317_321_377/{lang}",
            file_url=f"https://fedlex.data.admin.ch/filestore/x/{sr}-{lang}.xml",
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
        "220/de.xml",
        "220/fr.xml",
    ]
    assert (tmp_path / "220" / "de.xml").read_bytes() == b"<akomaNtoso/>"
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
