"""Integration against the locally cached real corpus (data/raw). Auto-skips without it."""
from datetime import date
from pathlib import Path

import pytest

from ingestion.akoma import parse_act
from ingestion.models import ManifestEntry

REPO_ROOT = Path(__file__).resolve().parents[3]
RAW_220_DE = REPO_ROOT / "data" / "raw" / "220" / "de.xml"

pytestmark = [
    pytest.mark.corpus,
    pytest.mark.skipif(not RAW_220_DE.exists(), reason="local corpus cache not present"),
]


def test_sr_220_de_parses_to_article_chunks() -> None:
    entry = ManifestEntry(
        sr="220",
        lang="de",
        act_name="Code of Obligations",
        abbrev="OR / CO",
        version_date=date(2026, 1, 1),
        eli="https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de",
        file_url="unused",
    )
    chunks = parse_act(RAW_220_DE, entry)
    # Observed 1611 chunks on 2026-08-05 after FIX C1 (empty-body skip); band covers
    # minor corpus drift between Fedlex snapshots.
    assert 1571 <= len(chunks) <= 1651
    by_article = {c.article: c for c in chunks}
    art = by_article["335c"]
    assert art.text.startswith("Art. 335c")
    assert art.heading is not None and "Probezeit" in art.heading
    assert art.eli.endswith("#art_335_c")
    assert all(c.text.partition("\n")[2].strip() for c in chunks)
