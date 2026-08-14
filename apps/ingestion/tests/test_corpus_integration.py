"""Integration against the locally cached real corpus (data/raw). Auto-skips without it."""
import json
from datetime import date
from pathlib import Path

import pytest

from ingestion.akoma import parse_act
from ingestion.models import ManifestEntry

REPO_ROOT = Path(__file__).resolve().parents[3]
RAW_220_DE = REPO_ROOT / "data" / "raw" / "CH" / "220" / "de.xml"
CHUNKS_DIR = REPO_ROOT / "data" / "chunks" / "CH"

pytestmark = [
    pytest.mark.corpus,
    pytest.mark.skipif(not RAW_220_DE.exists(), reason="local corpus cache not present"),
]


def test_sr_220_de_parses_to_article_chunks() -> None:
    entry = ManifestEntry(
        jurisdiction="CH",
        collection="SR",
        number="220",
        lang="de",
        act_name="Code of Obligations",
        abbrev="OR / CO",
        version_date=date(2026, 1, 1),
        source_url="https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de",
        file_url="unused",
        source="fedlex",
    )
    chunks = parse_act(RAW_220_DE, entry)
    # Observed 1611 chunks on 2026-08-05 after FIX C1 (empty-body skip); band covers
    # minor corpus drift between Fedlex snapshots.
    assert 1571 <= len(chunks) <= 1651
    by_article = {c.article: c for c in chunks}
    art = by_article["335c"]
    assert art.text.startswith("Art. 335c")
    assert art.heading is not None and "Probezeit" in art.heading
    assert art.source_url.endswith("#art_335_c")
    assert all(c.text.partition("\n")[2].strip() for c in chunks)


@pytest.mark.skipif(not CHUNKS_DIR.exists(), reason="run `ingest parse` first")
def test_all_generated_chunk_keys_are_globally_unique() -> None:
    # (jurisdiction, number, lang, eid, part) is the Postgres UNIQUE constraint (see
    # embed.SCHEMA_SQL). Two real duplicate source eIds exist in Fedlex XML (SR 220 FR
    # art_221, SR 220 IT art_219); parse_act must disambiguate them so no collision
    # survives to `ingest embed` across the whole corpus, not just one act/language.
    seen: dict[tuple[str, str, str, str, int], Path] = {}
    for path in sorted(CHUNKS_DIR.glob("*/*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            record = json.loads(line)
            key = (
                record["jurisdiction"],
                record["number"],
                record["lang"],
                record["eid"],
                record["part"] or 0,
            )
            prior = seen.get(key)
            assert prior is None, f"duplicate chunk key {key}: {path} vs {prior}"
            seen[key] = path
    # Vacuity guard: this test's skipif only probes data/raw, not data/chunks — with
    # raw present but `ingest parse` never run, CHUNKS_DIR.glob would yield nothing
    # and the loop above would pass having asserted nothing. Fail loud on that.
    assert len(seen) > 12000, f"only {len(seen)} chunk keys found — run `ingest parse` first"


@pytest.mark.skipif(not CHUNKS_DIR.exists(), reason="run `ingest parse` first")
def test_disambiguation_never_steals_another_articles_anchor_on_real_corpus() -> None:
    # Real FR/IT SR 220 shapes exercised by _disambiguate_duplicate_keys (see
    # test_akoma.py for the offline unit tests this mirrors):
    # - FR: art_220 genuinely holds Art. 219's text (header override); art_221 is
    #   duplicated between Art. 220 and Art. 221. Art. 220 may not steal "#art_220"
    #   (it belongs to Art. 219) — act-level source_url instead. Art. 219 was never
    #   colliding, so it keeps its correct source anchor "#art_220".
    # - IT: art_219 is duplicated between Art. 219 and Art. 219a. "#art_219_a" is
    #   absent from the document, so synthesizing it for Art. 219a is harmless.
    by_article: dict[tuple[str, str], dict] = {}
    for path in [CHUNKS_DIR / "220" / "fr.jsonl", CHUNKS_DIR / "220" / "it.jsonl"]:
        lang = path.stem
        for line in path.read_text(encoding="utf-8").splitlines():
            record = json.loads(line)
            by_article[(lang, record["article"])] = record

    # Vacuity guard: prove the test actually saw the rewritten chunks, not an empty file.
    assert len(by_article) > 0, f"no chunks found under {CHUNKS_DIR / '220'} — run `ingest parse` first"

    fr_source_url = by_article[("fr", "220")]["source_url"]
    assert fr_source_url == "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/fr", fr_source_url
    assert by_article[("fr", "219")]["source_url"].endswith("#art_220")
    assert by_article[("it", "219a")]["source_url"].endswith("#art_219_a")
