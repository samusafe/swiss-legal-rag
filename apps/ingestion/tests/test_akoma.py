from datetime import date
from pathlib import Path

import pytest
from lxml import etree

from ingestion.akoma import (
    AKN_NS,
    FEDLEX_NS,
    MAX_CHUNK_CHARS,
    _disambiguate_duplicate_keys,
    article_number,
    article_text,
    marginal_heading,
    parse_act,
)
from ingestion.models import Chunk, ManifestEntry
from tests.conftest import akn_doc


def first_article(doc: bytes) -> etree._Element:
    root = etree.fromstring(doc)
    article = root.find(f".//{{{AKN_NS}}}article")
    assert article is not None
    return article


@pytest.mark.parametrize(
    ("eid", "expected"),
    [("art_1", "1"), ("art_6_a", "6a"), ("art_335_c", "335c"), ("anx_1/art_2", "2")],
)
def test_article_number(eid: str, expected: str) -> None:
    assert article_number(eid) == expected


def test_article_number_rejects_unknown_eid() -> None:
    with pytest.raises(RuntimeError, match="chp_9"):
        article_number("chp_9")


def test_article_text_numbers_paragraphs() -> None:
    article = first_article(akn_doc(
        '<article eId="art_1"><num><b>Art. 1</b></num>'
        '<paragraph eId="art_1/para_1"><num>1</num><content><p> Erster  Satz.</p></content></paragraph>'
        '<paragraph eId="art_1/para_2"><num>2</num><content><p>Zweiter Satz.</p></content></paragraph>'
        "</article>"
    ))
    assert article_text(article) == "Art. 1\n1 Erster Satz.\n2 Zweiter Satz."


def test_article_text_unnumbered_single_paragraph() -> None:
    article = first_article(akn_doc(
        '<article eId="art_6"><num><b>Art. 6</b></num>'
        '<paragraph eId="art_6/para"><content><p>Nur ein Satz.</p></content></paragraph>'
        "</article>"
    ))
    assert article_text(article) == "Art. 6\nNur ein Satz."


def test_article_text_without_paragraph_elements() -> None:
    article = first_article(akn_doc(
        '<article eId="art_9"><num>Art. 9</num><content><p>Direkter Inhalt.</p></content></article>'
    ))
    assert article_text(article) == "Art. 9\nDirekter Inhalt."


def test_marginal_heading_uses_innermost_level() -> None:
    article = first_article(akn_doc(
        '<level eId="lvl_A" fedlex:role="marginal"><num>A. </num><heading>Outer</heading>'
        '<level eId="lvl_A/lvl_1" fedlex:role="marginal"><num>1. </num>'
        "<heading>Im <br/>Allgemeinen</heading>"
        '<article eId="art_1"><num>Art. 1</num></article>'
        "</level></level>"
    ))
    assert marginal_heading(article) == "Im Allgemeinen"


def test_marginal_heading_absent() -> None:
    article = first_article(akn_doc('<article eId="art_1"><num>Art. 1</num></article>'))
    assert marginal_heading(article) is None


# Task 3 tests


def entry_for(lang: str = "de") -> ManifestEntry:
    return ManifestEntry(
        sr="220",
        lang=lang,
        act_name="Code of Obligations",
        abbrev="OR / CO",
        version_date=date(2026, 1, 1),
        eli=f"https://www.fedlex.admin.ch/eli/cc/27/317_321_377/{lang}",
        file_url="https://fedlex.data.admin.ch/filestore/example.xml",
    )


def write_doc(tmp_path: Path, body_xml: str) -> Path:
    xml_path = tmp_path / "de.xml"
    xml_path.write_bytes(akn_doc(body_xml))
    return xml_path


def test_parse_act_builds_chunks_with_anchor(tmp_path: Path) -> None:
    xml_path = write_doc(tmp_path,
        '<level eId="lvl_A" fedlex:role="marginal"><heading>Kündigungsfristen</heading>'
        '<article eId="art_335_c"><num>Art. 335c</num>'
        '<paragraph eId="art_335_c/para_1"><num>1</num><content><p>Text A.</p></content></paragraph>'
        "</article></level>"
    )
    chunks = parse_act(xml_path, entry_for())
    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk.article == "335c"
    assert chunk.part is None
    assert chunk.heading == "Kündigungsfristen"
    assert chunk.text == "Art. 335c\n1 Text A."
    assert chunk.eli.endswith("/de#art_335_c")
    assert chunk.version_date == date(2026, 1, 1)


def test_parse_act_strips_authorial_notes(tmp_path: Path) -> None:
    xml_path = write_doc(tmp_path,
        '<article eId="art_1"><num><b>Art. 1</b><authorialNote>Fussnote 99</authorialNote></num>'
        '<paragraph eId="art_1/para_1"><num>1</num><content><p>Satz<authorialNote>AS 2020 123</authorialNote>.</p></content></paragraph>'
        "</article>"
    )
    chunks = parse_act(xml_path, entry_for())
    assert chunks[0].text == "Art. 1\n1 Satz."  # authorialNote element removed, tail preserved


def test_parse_act_skips_empty_body_articles(tmp_path: Path) -> None:
    xml_path = write_doc(tmp_path,
        '<article eId="art_88"><num><b>Art. 88</b><authorialNote>Aufgehoben durch Ziff. I</authorialNote></num></article>'
        '<article eId="art_89"><num>Art. 89</num>'
        '<paragraph eId="art_89/para"><content><p>Gültiger Inhalt der Bestimmung.</p></content></paragraph></article>'
    )
    chunks = parse_act(xml_path, entry_for())
    assert [c.article for c in chunks] == ["89"]


def test_parse_act_prefers_header_number_over_duplicate_eid(tmp_path: Path) -> None:
    xml_path = write_doc(tmp_path,
        '<article eId="art_221"><num>Art. 220</num>'
        '<paragraph eId="art_221/para"><content><p>Text.</p></content></paragraph></article>'
    )
    chunks = parse_act(xml_path, entry_for())
    assert len(chunks) == 1
    assert chunks[0].article == "220"
    assert chunks[0].eli.endswith("#art_221")


def test_parse_act_disambiguates_duplicate_eid(tmp_path: Path) -> None:
    xml_path = write_doc(tmp_path,
        '<article eId="art_221"><num>Art. 221</num>'
        '<paragraph eId="art_221/para"><content><p>Text 221.</p></content></paragraph></article>'
        '<article eId="art_221"><num>Art. 220</num>'
        '<paragraph eId="art_221/para2"><content><p>Text 220.</p></content></paragraph></article>'
    )
    chunks = parse_act(xml_path, entry_for())
    assert len(chunks) == 2
    by_article = {c.article: c for c in chunks}
    assert set(by_article) == {"220", "221"}
    assert by_article["221"].eli.endswith("#art_221")
    assert by_article["220"].eli.endswith("#art_220")
    assert by_article["221"].eli != by_article["220"].eli
    assert by_article["221"].eid == "art_221"
    assert by_article["220"].eid == "art_221"


_ELI = "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/fr"


def _entry() -> ManifestEntry:
    return ManifestEntry(
        sr="220", lang="fr", eli=_ELI, act_name="Code des obligations",
        abbrev="CO", version_date=date(2026, 1, 1),
        file_url="https://fedlex.data.admin.ch/example.xml",
    )


def _chunk(article: str, eid: str) -> Chunk:
    return Chunk(
        sr="220", lang="fr", article=article, eid=eid, part=None,
        heading=None, context=None, text=f"Art. {article}\nbody",
        eli=f"{_ELI}#{eid}", act_name="Code des obligations", abbrev="CO",
        version_date=date(2026, 1, 1),
    )


def test_disambiguation_never_steals_another_articles_anchor() -> None:
    # Real FR SR 220 shape: element art_220 holds Art. 219's text (header override),
    # element art_221 is duplicated between Art. 220 and Art. 221.
    chunks = [_chunk("219", "art_220"), _chunk("220", "art_221"), _chunk("221", "art_221")]
    eid_articles = {"art_220": {"219"}, "art_221": {"220", "221"}}

    resolved = _disambiguate_duplicate_keys(chunks, _entry(), eid_articles)

    by_article = {c.article: c for c in resolved}
    # Art. 220 may NOT take "#art_220" — that element belongs to Art. 219. Act-level fallback.
    assert by_article["220"].eli == _ELI
    # Art. 219 was never in a colliding group: keeps its (correct) source anchor.
    assert by_article["219"].eli == f"{_ELI}#art_220"
    assert by_article["221"].eli == f"{_ELI}#art_221"


def test_disambiguation_allows_absent_anchor() -> None:
    # IT SR 220 shape: art_219 duplicated between Art. 219 and Art. 219a;
    # "art_219_a" does not exist in the document, so synthesizing it is fine.
    chunks = [_chunk("219", "art_219"), _chunk("219a", "art_219")]
    eid_articles = {"art_219": {"219", "219a"}}

    resolved = _disambiguate_duplicate_keys(chunks, _entry(), eid_articles)

    by_article = {c.article: c for c in resolved}
    assert by_article["219"].eli == f"{_ELI}#art_219"
    assert by_article["219a"].eli == f"{_ELI}#art_219_a"


def test_disambiguation_never_synthesizes_top_level_anchor_for_annex_article() -> None:
    # Nested eIds ("anx_1/art_2") must not be rehomed onto a top-level "art_..." anchor.
    chunks = [_chunk("2", "anx_1/art_2"), _chunk("3", "anx_1/art_2")]
    eid_articles = {"anx_1/art_2": {"2", "3"}}

    resolved = _disambiguate_duplicate_keys(chunks, _entry(), eid_articles)

    by_article = {c.article: c for c in resolved}
    assert by_article["2"].eli == f"{_ELI}#anx_1/art_2"  # article 2 matches eid number: keeps
    assert by_article["3"].eli == _ELI                    # mismatched nested: act-level, never "#art_3"


def test_parse_act_splits_oversized_articles(tmp_path: Path) -> None:
    long_sentence = "Wort " * 500  # ~2500 chars per paragraph
    paras = "".join(
        f'<paragraph eId="art_7/para_{i}"><num>{i}</num><content><p>{long_sentence}</p></content></paragraph>'
        for i in range(1, 6)
    )
    xml_path = write_doc(tmp_path, f'<article eId="art_7"><num>Art. 7</num>{paras}</article>')
    chunks = parse_act(xml_path, entry_for())
    assert len(chunks) > 1
    assert [c.part for c in chunks] == list(range(1, len(chunks) + 1))
    assert all(c.text.startswith("Art. 7\n") for c in chunks)
    assert all(len(c.text) <= MAX_CHUNK_CHARS for c in chunks)


def test_parse_act_fails_loud_on_empty_body(tmp_path: Path) -> None:
    xml_path = write_doc(tmp_path, "<chapter eId='chp_1'></chapter>")
    with pytest.raises(RuntimeError, match="220"):
        parse_act(xml_path, entry_for())


def test_parse_act_fails_loud_on_missing_file(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="missing"):
        parse_act(tmp_path / "nope.xml", entry_for())


def test_parse_act_does_not_resolve_external_entities(tmp_path: Path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("PWNED", encoding="utf-8")
    xml_path = tmp_path / "de.xml"
    xml_path.write_bytes(
        (
            '<?xml version="1.0"?>\n'
            f'<!DOCTYPE akomaNtoso [<!ENTITY xxe SYSTEM "file:///{secret.as_posix()}">]>\n'
            f'<akomaNtoso xmlns="{AKN_NS}" xmlns:fedlex="{FEDLEX_NS}">'
            '<act><body><article eId="art_1"><num>Art. 1</num>'
            '<paragraph eId="art_1/para"><content><p>&xxe;</p></content></paragraph>'
            "</article></body></act></akomaNtoso>"
        ).encode()
    )
    chunks = parse_act(xml_path, entry_for())
    assert "PWNED" not in chunks[0].text


def test_parse_act_skips_repeal_stub_bodies(tmp_path: Path) -> None:
    xml_path = write_doc(tmp_path,
        '<article eId="art_732_a"><num>Art. 732a</num>'
        '<paragraph eId="art_732_a/para"><content><p>Aufgehoben</p></content></paragraph></article>'
        '<article eId="art_733"><num>Art. 733</num>'
        '<paragraph eId="art_733/para"><content><p>Weiterhin geltender Inhalt.</p></content></paragraph></article>'
    )
    assert [c.article for c in parse_act(xml_path, entry_for())] == ["733"]


def test_parse_act_skips_plural_repeal_stubs(tmp_path: Path) -> None:
    xml_path = write_doc(tmp_path,
        '<article eId="art_150"><num>Art. 150 à 158</num>'
        '<paragraph eId="art_150/para"><content><p>Abrogés</p></content></paragraph></article>'
    )
    with pytest.raises(RuntimeError, match="no chunks"):
        parse_act(xml_path, entry_for("fr"))


def test_chunk_carries_eid_and_breadcrumb(tmp_path: Path) -> None:
    xml_path = write_doc(tmp_path,
        '<level eId="lvl_A" fedlex:role="marginal"><heading>Beendigung</heading>'
        '<level eId="lvl_A/lvl_1" fedlex:role="marginal"><heading>Kündigungsfristen</heading>'
        '<article eId="art_335_c"><num>Art. 335c</num>'
        '<paragraph eId="art_335_c/para"><content><p>Inhalt.</p></content></paragraph>'
        "</article></level></level>"
    )
    chunk = parse_act(xml_path, entry_for())[0]
    assert chunk.eid == "art_335_c"
    assert chunk.context == "Beendigung › Kündigungsfristen"
    assert chunk.heading == "Kündigungsfristen"


def test_parse_act_repealed_element_still_owns_its_eid(tmp_path: Path) -> None:
    # eid ownership must be recorded BEFORE the repealed-skip: the repealed element
    # <article eId="art_3"> (whose header says Art. 4) still owns "#art_3", so a
    # duplicate-key chunk for Art. 3 may not synthesize that anchor and must fall
    # back to the act-level ELI instead of pointing at another article's element.
    xml_path = write_doc(tmp_path,
        '<article eId="art_3"><num>Art. 4</num></article>'
        '<article eId="art_2"><num>Art. 2</num>'
        '<paragraph eId="art_2/para"><content><p>Text zwei.</p></content></paragraph></article>'
        '<article eId="art_2"><num>Art. 3</num>'
        '<paragraph eId="art_2/para2"><content><p>Text drei.</p></content></paragraph></article>'
    )
    chunks = parse_act(xml_path, entry_for())
    by_article = {c.article: c for c in chunks}
    assert set(by_article) == {"2", "3"}
    assert by_article["2"].eli.endswith("#art_2")
    assert by_article["3"].eli == entry_for().eli
