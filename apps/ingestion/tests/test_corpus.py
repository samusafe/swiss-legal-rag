from pathlib import Path

import pytest

from ingestion.corpus import load_corpus

YAML = """\
jurisdictions:
  - code: CH
    source: fedlex
    collection: SR
    languages: [de, fr, it]
    acts:
      - number: "220"
        name: Code of Obligations
        abbrev: OR / CO
  - code: SG
    source: lexwork
    collection: sGS
    base_url: https://www.gesetzessammlung.sg.ch
    languages: [de]
    acts:
      - number: "811.1"
        name: Tax Act
        abbrev: StG
"""

def test_load_corpus_jurisdictions(tmp_path: Path) -> None:
    p = tmp_path / "corpus.yaml"
    p.write_text(YAML, encoding="utf-8")
    corpus = load_corpus(p)
    assert [j.code for j in corpus.jurisdictions] == ["CH", "SG"]
    ch, sg = corpus.jurisdictions
    assert ch.source == "fedlex" and ch.base_url is None
    assert sg.source == "lexwork" and sg.collection == "sGS"
    assert sg.base_url == "https://www.gesetzessammlung.sg.ch"
    assert sg.acts[0].number == "811.1"

def test_lexwork_requires_base_url(tmp_path: Path) -> None:
    bad = YAML.replace("    base_url: https://www.gesetzessammlung.sg.ch\n", "")
    p = tmp_path / "corpus.yaml"
    p.write_text(bad, encoding="utf-8")
    with pytest.raises(ValueError, match="base_url"):
        load_corpus(p)


# I5: nothing else loads the checked-in corpus.yaml, so a typo'd base_url, a
# dropped abbrev, or a mistyped cantonal number would otherwise pass CI silently
# and only surface 20 minutes into a real ingest run. No network involved.
REPO_ROOT = Path(__file__).resolve().parents[3]


def test_real_corpus_yaml_matches_the_16_verified_pilot_acts() -> None:
    corpus = load_corpus(REPO_ROOT / "corpus.yaml")

    assert [j.code for j in corpus.jurisdictions] == ["CH", "SG", "BE"]
    by_code = {j.code: j for j in corpus.jurisdictions}

    ch, sg, be = by_code["CH"], by_code["SG"], by_code["BE"]
    assert len(ch.acts) == 10
    assert len(sg.acts) == 8
    assert len(be.acts) == 8

    assert [a.number for a in sg.acts] == [
        "111.1", "811.1", "731.1", "213.1", "381.1", "451.1", "151.2", "140.1",
    ]
    assert [a.number for a in be.acts] == [
        "101.1", "661.11", "721.0", "432.210", "551.1", "860.1", "170.11", "153.01",
    ]

    assert sg.languages == ["de"]
    assert be.languages == ["de", "fr"]

    assert sg.collection == "sGS"
    assert be.collection == "BSG"

    assert sg.source == "lexwork" and be.source == "lexwork"
    assert sg.base_url == "https://www.gesetzessammlung.sg.ch"
    assert be.base_url == "https://www.belex.sites.be.ch"

    for jur in corpus.jurisdictions:
        numbers = [a.number for a in jur.acts]
        assert len(numbers) == len(set(numbers)), f"{jur.code}: duplicate act numbers"
        if jur.source == "lexwork":
            assert (jur.base_url or "").startswith("https://"), (
                f"{jur.code}: base_url must start with https://"
            )
        for act in jur.acts:
            assert act.abbrev.strip(), f"{jur.code} {act.number}: blank abbrev"
            assert act.name.strip(), f"{jur.code} {act.number}: blank name"
