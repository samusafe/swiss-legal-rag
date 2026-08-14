import json
from datetime import date
from pathlib import Path

import httpx
import pytest

from ingestion.corpus import Act, CorpusConfig, Jurisdiction
from ingestion.resolve import resolve_corpus
from tests.conftest import make_client, sparql_response, sparql_row


def test_resolve_corpus_builds_manifest(tmp_path: Path) -> None:
    base = "https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/27/317_321_377"
    rows = [
        sparql_row("DEU", "2026-01-01", f"{base}/20260101/de/xml/a-de.xml"),
        sparql_row("FRA", "2026-01-01", f"{base}/20260101/fr/xml/a-fr.xml"),
        sparql_row("ITA", "2026-01-01", f"{base}/20260101/it/xml/a-it.xml"),
    ]
    client = make_client(lambda request: httpx.Response(200, json=sparql_response(rows)))
    corpus = CorpusConfig(
        jurisdictions=[
            Jurisdiction(
                code="CH",
                source="fedlex",
                collection="SR",
                languages=["de", "fr", "it"],
                acts=[Act(number="220", name="Code of Obligations", abbrev="OR / CO")],
            )
        ]
    )
    sleeps: list[float] = []

    manifest, failures = resolve_corpus(
        corpus, client, today=date(2026, 8, 5), sleep=sleeps.append, raw_dir=tmp_path
    )

    assert failures == []
    assert len(manifest.entries) == 3
    entry = manifest.entries[0]
    assert (entry.jurisdiction, entry.collection, entry.number, entry.lang) == (
        "CH",
        "SR",
        "220",
        "de",
    )
    assert entry.act_name == "Code of Obligations"
    assert entry.source == "fedlex"
    assert entry.source_url == "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de"
    assert entry.version_date == date(2026, 1, 1)
    # single act -> no inter-act sleep needed
    assert sleeps == []


def test_resolve_corpus_sleeps_between_acts(
    sparql_client: httpx.Client, tmp_path: Path
) -> None:
    corpus = CorpusConfig(
        jurisdictions=[
            Jurisdiction(
                code="CH",
                source="fedlex",
                collection="SR",
                languages=["de", "fr", "it"],
                acts=[
                    Act(number="220", name="Code of Obligations", abbrev="OR / CO"),
                    Act(number="210", name="Civil Code", abbrev="ZGB / CC"),
                ],
            )
        ]
    )
    sleeps: list[float] = []

    manifest, failures = resolve_corpus(
        corpus, sparql_client, today=date(2026, 8, 5), sleep=sleeps.append, raw_dir=tmp_path
    )

    assert failures == []
    assert sleeps == [1.0]
    assert len(manifest.entries) == 6


def _lexwork_payload(
    number: str, title: str, abbrev: str, canonical_link: str, enactment_html: str,
) -> dict[str, object]:
    xhtml = (
        "<div class='document'>"
        f"<div class='enactment'>{enactment_html}</div>"
        "<div class='article'>"
        "<div class='article_number'><span class='article_symbol'>Art.</span>"
        "<span class='number'>1</span></div>"
        "<div class='article_title'><span class='title_text'>Titel</span></div>"
        "</div>"
        "<div class='paragraph'><span class='number'>1</span>"
        "<p><span class='text_content'>Inhalt.</span></p></div>"
        "</div>"
    )
    return {
        "text_of_law": {
            "title": title,
            "abbreviation": f"({abbrev})",
            "systematic_number": number,
            "canonical_link": canonical_link,
            "enactment": "2010-01-01",
            "selected_version": {"xhtml_tol": xhtml},
        }
    }


def test_resolve_corpus_dispatches_lexwork(tmp_path: Path) -> None:
    payload = _lexwork_payload(
        "811.1", "Steuergesetz", "StG",
        "https://www.gesetzessammlung.sg.ch/app/de/texts_of_law/811.1",
        "vom 01.01.1998 (Stand 01.01.2026)",
    )
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, json=payload)

    client = make_client(handler)
    corpus = CorpusConfig(jurisdictions=[Jurisdiction(
        code="SG", source="lexwork", collection="sGS",
        base_url="https://www.gesetzessammlung.sg.ch", languages=["de"],
        acts=[Act(number="811.1", name="Tax Act", abbrev="StG")],
    )])
    sleeps: list[float] = []

    manifest, failures = resolve_corpus(
        corpus, client, today=date(2026, 8, 13), sleep=sleeps.append, raw_dir=tmp_path
    )

    assert failures == []
    assert requested == ["https://www.gesetzessammlung.sg.ch/api/de/texts_of_law/811.1"]
    assert sleeps == [1.0]
    assert len(manifest.entries) == 1
    entry = manifest.entries[0]
    assert (entry.jurisdiction, entry.collection, entry.number, entry.lang) == (
        "SG", "sGS", "811.1", "de",
    )
    assert entry.act_name == "Steuergesetz"
    assert entry.abbrev == "StG"
    assert entry.version_date == date(2026, 1, 1)
    assert entry.source == "lexwork"
    assert entry.source_url == "https://www.gesetzessammlung.sg.ch/app/de/texts_of_law/811.1"
    assert entry.file_url == "https://www.gesetzessammlung.sg.ch/api/de/texts_of_law/811.1"
    cached = tmp_path / "SG" / "811.1.de.json"
    assert cached.exists()
    assert json.loads(cached.read_text(encoding="utf-8")) == payload


def test_resolve_lexwork_missing_key_continues_and_collects_failure(tmp_path: Path) -> None:
    # I3: a missing required key in one act's response must not abort the whole
    # resolve — it's collected as a failure and the run continues.
    payload = _lexwork_payload(
        "811.1", "Steuergesetz", "StG",
        "https://www.gesetzessammlung.sg.ch/app/de/texts_of_law/811.1",
        "vom 01.01.1998 (Stand 01.01.2026)",
    )
    tol = payload["text_of_law"]
    assert isinstance(tol, dict)
    del tol["canonical_link"]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    client = make_client(handler)
    corpus = CorpusConfig(jurisdictions=[Jurisdiction(
        code="SG", source="lexwork", collection="sGS",
        base_url="https://www.gesetzessammlung.sg.ch", languages=["de"],
        acts=[Act(number="811.1", name="Tax Act", abbrev="StG")],
    )])

    manifest, failures = resolve_corpus(
        corpus, client, today=date(2026, 8, 13), sleep=lambda _: None, raw_dir=tmp_path
    )

    assert manifest.entries == []
    assert len(failures) == 1
    failure = failures[0]
    assert failure.jurisdiction == "SG"
    assert failure.number == "811.1"
    assert failure.lang == "de"
    assert "811.1" in failure.error
    assert "de" in failure.error
    assert "canonical_link" in failure.error


def test_resolve_lexwork_number_mismatch_fails_loud_with_both_values(tmp_path: Path) -> None:
    # I2: the raw-cache filename and ManifestEntry.number are both keyed on
    # corpus.yaml's act.number — a disagreement with the API's systematic_number
    # must fail loud (naming both values and corpus.yaml) instead of silently
    # caching under one number while the manifest points at the other.
    payload = _lexwork_payload(
        "153.1", "Personalgesetz", "PG",  # API returns "153.1", corpus.yaml has "153.01"
        "https://www.belex.sites.be.ch/app/de/texts_of_law/153.01",
        "vom 01.01.1998 (Stand 01.01.2026)",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    client = make_client(handler)
    corpus = CorpusConfig(jurisdictions=[Jurisdiction(
        code="BE", source="lexwork", collection="BSG",
        base_url="https://www.belex.sites.be.ch", languages=["de"],
        acts=[Act(number="153.01", name="Personalgesetz", abbrev="PG")],
    )])

    manifest, failures = resolve_corpus(
        corpus, client, today=date(2026, 8, 13), sleep=lambda _: None, raw_dir=tmp_path
    )

    assert manifest.entries == []
    assert len(failures) == 1
    failure = failures[0]
    assert failure.jurisdiction == "BE" and failure.number == "153.01"
    assert "153.01" in failure.error  # corpus.yaml's value
    assert "153.1" in failure.error  # the API's value
    assert "corpus.yaml" in failure.error
    # no cache file written under either number — nothing to diverge from
    assert not (tmp_path / "BE").exists()


def test_resolve_lexwork_number_agree_path_succeeds(tmp_path: Path) -> None:
    # Companion to the mismatch test: when the API's systematic_number matches
    # corpus.yaml's act.number, resolution succeeds as normal.
    payload = _lexwork_payload(
        "811.1", "Steuergesetz", "StG",
        "https://www.gesetzessammlung.sg.ch/app/de/texts_of_law/811.1",
        "vom 01.01.1998 (Stand 01.01.2026)",
    )
    client = make_client(lambda request: httpx.Response(200, json=payload))
    corpus = CorpusConfig(jurisdictions=[Jurisdiction(
        code="SG", source="lexwork", collection="sGS",
        base_url="https://www.gesetzessammlung.sg.ch", languages=["de"],
        acts=[Act(number="811.1", name="Tax Act", abbrev="StG")],
    )])

    manifest, failures = resolve_corpus(
        corpus, client, today=date(2026, 8, 13), sleep=lambda _: None, raw_dir=tmp_path
    )

    assert failures == []
    assert len(manifest.entries) == 1
    assert manifest.entries[0].number == "811.1"
    assert (tmp_path / "SG" / "811.1.de.json").exists()


def test_resolve_lexwork_one_bad_act_continues_to_the_next(tmp_path: Path) -> None:
    # I3: one failing act (simulated 404) must not discard the other acts.
    good_payload = _lexwork_payload(
        "811.1", "Steuergesetz", "StG",
        "https://www.gesetzessammlung.sg.ch/app/de/texts_of_law/811.1",
        "vom 01.01.1998 (Stand 01.01.2026)",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if "111.1" in str(request.url):
            return httpx.Response(404, text="not found")
        return httpx.Response(200, json=good_payload)

    client = make_client(handler)
    corpus = CorpusConfig(jurisdictions=[Jurisdiction(
        code="SG", source="lexwork", collection="sGS",
        base_url="https://www.gesetzessammlung.sg.ch", languages=["de"],
        acts=[
            Act(number="111.1", name="Verfassung", abbrev="KV"),
            Act(number="811.1", name="Tax Act", abbrev="StG"),
        ],
    )])

    manifest, failures = resolve_corpus(
        corpus, client, today=date(2026, 8, 13), sleep=lambda _: None, raw_dir=tmp_path
    )

    assert len(manifest.entries) == 1
    assert manifest.entries[0].number == "811.1"
    assert len(failures) == 1
    assert failures[0].number == "111.1"
    assert "404" in failures[0].error


def test_resolve_fedlex_one_bad_act_continues_and_saves_the_rest(tmp_path: Path) -> None:
    # I3, fedlex side: mirrors the lexwork per-act resilience test above so both
    # source paths behave consistently.
    base = "https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/27/317_321_377"
    good_rows = [
        sparql_row("DEU", "2026-01-01", f"{base}/20260101/de/xml/a-de.xml"),
        sparql_row("FRA", "2026-01-01", f"{base}/20260101/fr/xml/a-fr.xml"),
        sparql_row("ITA", "2026-01-01", f"{base}/20260101/it/xml/a-it.xml"),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if b"999" in request.content:
            return httpx.Response(500, text="sparql endpoint error")
        return httpx.Response(200, json=sparql_response(good_rows))

    client = make_client(handler)
    corpus = CorpusConfig(
        jurisdictions=[
            Jurisdiction(
                code="CH", source="fedlex", collection="SR",
                languages=["de", "fr", "it"],
                acts=[
                    Act(number="999", name="Nonexistent Act", abbrev="X"),
                    Act(number="220", name="Code of Obligations", abbrev="OR / CO"),
                ],
            )
        ]
    )

    manifest, failures = resolve_corpus(
        corpus, client, today=date(2026, 8, 5), sleep=lambda _: None, raw_dir=tmp_path
    )

    assert len(manifest.entries) == 3  # the good act's 3 languages
    assert all(e.number == "220" for e in manifest.entries)
    assert len(failures) == 1
    assert failures[0].jurisdiction == "CH" and failures[0].number == "999"
    assert "500" in failures[0].error


def test_resolve_lexwork_rejects_non_https_base_url(tmp_path: Path) -> None:
    # M2: a non-https base_url must fail loud with context, not be silently used.
    client = make_client(lambda request: httpx.Response(200, json={}))
    corpus = CorpusConfig(jurisdictions=[Jurisdiction(
        code="SG", source="lexwork", collection="sGS",
        base_url="http://www.gesetzessammlung.sg.ch", languages=["de"],
        acts=[Act(number="811.1", name="Tax Act", abbrev="StG")],
    )])

    manifest, failures = resolve_corpus(
        corpus, client, today=date(2026, 8, 13), sleep=lambda _: None, raw_dir=tmp_path
    )

    assert manifest.entries == []
    assert len(failures) == 1
    assert "https://" in failures[0].error


def test_resolve_lexwork_rejects_unsafe_act_number(tmp_path: Path) -> None:
    # M2: an act number that isn't a plain systematic-collection number (e.g. a
    # path-traversal attempt) must fail loud instead of being interpolated into
    # the request URL and the cache filename.
    client = make_client(lambda request: httpx.Response(200, json={}))
    corpus = CorpusConfig(jurisdictions=[Jurisdiction(
        code="SG", source="lexwork", collection="sGS",
        base_url="https://www.gesetzessammlung.sg.ch", languages=["de"],
        acts=[Act(number="../../etc/passwd", name="Bad", abbrev="X")],
    )])

    manifest, failures = resolve_corpus(
        corpus, client, today=date(2026, 8, 13), sleep=lambda _: None, raw_dir=tmp_path
    )

    assert manifest.entries == []
    assert len(failures) == 1
    assert "act number" in failures[0].error


def test_resolve_lexwork_null_text_of_law_fails_loud_not_attributeerror(
    tmp_path: Path,
) -> None:
    # M3: a present-but-null "text_of_law" must produce a contextual failure,
    # not a bare AttributeError/TypeError.
    client = make_client(lambda request: httpx.Response(200, json={"text_of_law": None}))
    corpus = CorpusConfig(jurisdictions=[Jurisdiction(
        code="SG", source="lexwork", collection="sGS",
        base_url="https://www.gesetzessammlung.sg.ch", languages=["de"],
        acts=[Act(number="811.1", name="Tax Act", abbrev="StG")],
    )])

    manifest, failures = resolve_corpus(
        corpus, client, today=date(2026, 8, 13), sleep=lambda _: None, raw_dir=tmp_path
    )

    assert manifest.entries == []
    assert len(failures) == 1
    assert "text_of_law" in failures[0].error


def test_cli_resolve_writes_manifest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
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
        "jurisdictions:\n"
        "  - code: CH\n"
        "    source: fedlex\n"
        "    collection: SR\n"
        "    languages: [de, fr, it]\n"
        "    acts:\n"
        "      - number: \"220\"\n"
        "        name: Code of Obligations\n"
        "        abbrev: OR / CO\n",
        encoding="utf-8",
    )

    cli.main(
        ["resolve", "--corpus", str(corpus_file), "--data-dir", str(tmp_path / "data")]
    )

    manifest = ManifestModel.load(tmp_path / "data" / "manifest.json")
    assert len(manifest.entries) == 3


def test_cli_resolve_saves_manifest_and_exits_nonzero_on_partial_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # I3: one bad act must not prevent the CLI from saving the good entries, and
    # must still surface as a non-zero exit code so CI/the operator notices.
    from ingestion import cli
    from ingestion.models import Manifest as ManifestModel

    base = "https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/27/317_321_377"
    good_rows = [
        sparql_row("DEU", "2026-01-01", f"{base}/20260101/de/xml/a-de.xml"),
        sparql_row("FRA", "2026-01-01", f"{base}/20260101/fr/xml/a-fr.xml"),
        sparql_row("ITA", "2026-01-01", f"{base}/20260101/it/xml/a-it.xml"),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        if b"999" in request.content:
            return httpx.Response(500, text="sparql endpoint error")
        return httpx.Response(200, json=sparql_response(good_rows))

    client = make_client(handler)
    monkeypatch.setattr(cli, "_make_client", lambda: client)

    corpus_file = tmp_path / "corpus.yaml"
    corpus_file.write_text(
        "jurisdictions:\n"
        "  - code: CH\n"
        "    source: fedlex\n"
        "    collection: SR\n"
        "    languages: [de, fr, it]\n"
        "    acts:\n"
        "      - number: \"999\"\n"
        "        name: Nonexistent Act\n"
        "        abbrev: X\n"
        "      - number: \"220\"\n"
        "        name: Code of Obligations\n"
        "        abbrev: OR / CO\n",
        encoding="utf-8",
    )

    with pytest.raises(SystemExit) as exc_info:
        cli.main(["resolve", "--corpus", str(corpus_file), "--data-dir", str(tmp_path / "data")])
    assert exc_info.value.code == 1

    manifest = ManifestModel.load(tmp_path / "data" / "manifest.json")
    assert len(manifest.entries) == 3
    assert all(e.number == "220" for e in manifest.entries)
