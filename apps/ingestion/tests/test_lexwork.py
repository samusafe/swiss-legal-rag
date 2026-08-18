import json
from datetime import date
from pathlib import Path

import pytest

from ingestion.lexwork import parse_lexwork, version_date_from
from ingestion.models import ManifestEntry

FIXTURE = Path(__file__).parent / "fixtures" / "lexwork_sample.json"


def entry() -> ManifestEntry:
    return ManifestEntry(
        jurisdiction="SG", collection="sGS", number="151.2", lang="de",
        act_name="Gemeindegesetz", abbrev="GG", version_date=date(2026, 1, 1),
        source_url="https://www.gesetzessammlung.sg.ch/app/de/texts_of_law/151.2",
        file_url="https://www.gesetzessammlung.sg.ch/api/de/texts_of_law/151.2",
        source="lexwork",
    )


def test_parse_extracts_articles() -> None:
    chunks = parse_lexwork(FIXTURE, entry())
    assert [c.article for c in chunks] == ["1", "2"]
    first = chunks[0]
    assert first.eid == "art_1"
    assert first.jurisdiction == "SG" and first.collection == "sGS"
    assert "Geltungsbereich" in (first.heading or "")
    assert "politischen Gemeinden" in first.text          # enumeration items included
    assert first.context is not None and "Allgemeine Bestimmungen" in first.context


def test_parse_skips_abrogated_paragraph() -> None:
    # Art. 1 §3 is repealed (marked with span.abrogation_ellip): its "3 …*" remnant
    # must not leak into the chunk text, but live paragraphs 1 and 2 (and its
    # enumeration items) must survive.
    first = parse_lexwork(FIXTURE, entry())[0]
    assert "…" not in first.text
    assert "Dieser Erlass" in first.text
    assert "Gemeinden sind" in first.text
    assert "politischen Gemeinden" in first.text


def test_parse_article_without_number_span_fails_loud(tmp_path: Path) -> None:
    xhtml = (
        "<div class='document'>"
        "<div class='article'>"
        "<div class='article_title'><span class='title_text'>Bad</span></div>"
        "</div>"
        "<div class='paragraph'><span class='number'>1</span>"
        "<p><span class='text_content'>Text.</span></p></div>"
        "</div>"
    )
    payload = {"text_of_law": {"selected_version": {"xhtml_tol": xhtml}}}
    path = tmp_path / "malformed.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="SG"):
        parse_lexwork(path, entry())


def test_oversized_lexwork_article_splits_without_duplicating_paragraph_1(
    tmp_path: Path,
) -> None:
    # I1: LexWork chunk text has no "Art. N" header line (unlike Fedlex), so the
    # shared Fedlex splitter's "repeat line 0 as a header" behavior would repeat
    # paragraph 1 into every part. part>0 must not start with paragraph 1's text.
    para_1_text = "Erster Absatz Inhalt. " * 5  # distinctive prefix, checked below
    long_para_text = "Lorem ipsum dolor sit amet consectetur adipiscing elit. " * 100
    paragraphs = "".join(
        "<div class='paragraph'><span class='number'>"
        f"{i}</span><p><span class='text_content'>"
        f"{para_1_text if i == 1 else long_para_text}"
        "</span></p></div>"
        for i in range(1, 12)  # 11 paragraphs, well over MAX_CHUNK_CHARS combined
    )
    xhtml = (
        "<div class='document'>"
        "<div class='article'>"
        "<div class='article_number'><span class='article_symbol'>Art.</span>"
        "<span class='number'>1</span></div>"
        "</div>" + paragraphs + "</div>"
    )
    payload = {"text_of_law": {"selected_version": {"xhtml_tol": xhtml}}}
    path = tmp_path / "oversized.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    chunks = parse_lexwork(path, entry())

    assert len(chunks) > 1  # actually split
    parts = sorted(chunks, key=lambda c: c.part or 0)
    assert [c.part for c in parts] == list(range(1, len(parts) + 1))
    # Every part opens with a synthesized "Art. N" header, never with raw
    # paragraph text — and part>0's text must not start with paragraph 1's text.
    for chunk in parts:
        assert chunk.text.startswith("Art. 1")
    for chunk in parts[1:]:
        assert not chunk.text.startswith(f"Art. 1\n{para_1_text.strip()}")
    # paragraph 1's content appears exactly once across all parts, not
    # repeated into every one of them (the bug this test guards against).
    occurrences = sum(1 for c in parts if "Erster Absatz" in c.text)
    assert occurrences == 1


def test_parse_lexwork_null_text_of_law_fails_loud_not_attributeerror(
    tmp_path: Path,
) -> None:
    # M3: a present-but-null "text_of_law" (distinct from an absent key) must
    # raise a contextual ValueError, not a bare AttributeError from `.get()`
    # being called on None.
    path = tmp_path / "null_tol.json"
    path.write_text(json.dumps({"text_of_law": None}), encoding="utf-8")

    with pytest.raises(ValueError, match="no xhtml_tol"):
        parse_lexwork(path, entry())


def test_parse_strips_trailing_asterisk_marker_from_number_sibling(
    tmp_path: Path,
) -> None:
    # BE (BSG) marks amended articles with a trailing "*". Variant: the asterisk
    # sits in a <strong> sibling next to (not inside) the number span.
    xhtml = (
        "<div class='document'>"
        "<div class='article'>"
        "<div class='article_number'><span class='article_symbol'>Art.</span> "
        "<span class='number'>32a</span> <strong>*</strong></div>"
        "<div class='article_title'>"
        "<span class='title_text'>Geltung der Baubewilligung <strong>*</strong></span>"
        "</div>"
        "</div>"
        "<div class='paragraph'><span class='number'>1</span>"
        "<p><span class='text_content'>Text.</span></p></div>"
        "</div>"
    )
    payload = {"text_of_law": {"selected_version": {"xhtml_tol": xhtml}}}
    path = tmp_path / "be_sibling.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    chunk = parse_lexwork(path, entry())[0]
    assert chunk.article == "32a"
    assert chunk.eid == "art_32a"
    assert chunk.heading == "Geltung der Baubewilligung"


def test_parse_strips_trailing_asterisk_marker_inside_number_span(
    tmp_path: Path,
) -> None:
    # Real BSG (721.0) markup: the asterisk is nested *inside* the number span
    # itself, e.g. "<span class='number'>32a&nbsp;<strong>*</strong></span>",
    # which `_text()` renders as "32a *" before sanitization.
    xhtml = (
        "<div class='document'>"
        "<div class='article'>"
        "<div class='article_number'><span class='article_symbol'>Art.</span> "
        "<span class='number'>32a <strong>*</strong></span></div>"
        "<div class='article_title'>"
        "<span class='title_text'>4.2 Schutz und Erhaltung <strong>*</strong></span>"
        "</div>"
        "</div>"
        "<div class='paragraph'><span class='number'>1</span>"
        "<p><span class='text_content'>Text.</span></p></div>"
        "</div>"
    )
    payload = {"text_of_law": {"selected_version": {"xhtml_tol": xhtml}}}
    path = tmp_path / "be_nested.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    chunk = parse_lexwork(path, entry())[0]
    assert chunk.article == "32a"
    assert chunk.eid == "art_32a"
    assert chunk.heading == "4.2 Schutz und Erhaltung"
    assert "*" not in chunk.article
    assert "*" not in chunk.eid
    assert (chunk.heading or "").strip()[-1] != "*"


def test_parse_strips_trailing_asterisk_marker_from_breadcrumb(
    tmp_path: Path,
) -> None:
    xhtml = (
        "<div class='document'>"
        "<div class='title level_1'><span class='title_text'>1 Allgemeines <strong>*</strong></span></div>"
        "<div class='article'>"
        "<div class='article_number'><span class='article_symbol'>Art.</span> "
        "<span class='number'>1</span></div>"
        "</div>"
        "<div class='paragraph'><span class='number'>1</span>"
        "<p><span class='text_content'>Text.</span></p></div>"
        "</div>"
    )
    payload = {"text_of_law": {"selected_version": {"xhtml_tol": xhtml}}}
    path = tmp_path / "be_breadcrumb.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    chunk = parse_lexwork(path, entry())[0]
    assert chunk.context == "1 Allgemeines"


def test_version_date_stand_german() -> None:
    assert version_date_from("vom 21.04.2009 (Stand 01.01.2026)", None) == date(2026, 1, 1)


def test_version_date_french_fallback() -> None:
    assert version_date_from("du 06.06.1993 (état au 11.12.2013)", None) == date(2013, 12, 11)


def test_version_date_enactment_fallback() -> None:
    assert version_date_from("no marker here", "1999-01-01") == date(1999, 1, 1)


def test_version_date_missing_raises() -> None:
    import pytest
    with pytest.raises(ValueError, match="version date"):
        version_date_from("no marker", None)
