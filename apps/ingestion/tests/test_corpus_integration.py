"""Integration against the locally cached real corpus (data/raw). Auto-skips without it."""
import json
from datetime import date
from pathlib import Path

import pytest

from ingestion.akoma import parse_act
from ingestion.models import ManifestEntry

REPO_ROOT = Path(__file__).resolve().parents[3]
RAW_220_DE = REPO_ROOT / "data" / "raw" / "220" / "de.xml"
CHUNKS_DIR = REPO_ROOT / "data" / "chunks"

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


@pytest.mark.skipif(not CHUNKS_DIR.exists(), reason="run `ingest parse` first")
def test_all_generated_chunk_keys_are_globally_unique() -> None:
    # (eli, part) is the Postgres UNIQUE constraint (see embed.SCHEMA_SQL). Two real
    # duplicate source eIds exist in Fedlex XML (SR 220 FR art_221, SR 220 IT
    # art_219); parse_act must disambiguate them so no collision survives to `ingest
    # embed` across the whole corpus, not just one act/language.
    seen: dict[tuple[str, int], Path] = {}
    for path in sorted(CHUNKS_DIR.glob("*/*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            record = json.loads(line)
            key = (record["eli"], record["part"] or 0)
            prior = seen.get(key)
            assert prior is None, f"duplicate chunk key {key}: {path} vs {prior}"
            seen[key] = path
    # Vacuity guard: this test's skipif only probes data/raw, not data/chunks — with
    # raw present but `ingest parse` never run, CHUNKS_DIR.glob would yield nothing
    # and the loop above would pass having asserted nothing. Fail loud on that.
    assert len(seen) > 12000, f"only {len(seen)} chunk keys found — run `ingest parse` first"
