from pathlib import Path

from ingestion.corpus import load_corpus

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_load_corpus_from_yaml(tmp_path: Path) -> None:
    yaml_file = tmp_path / "corpus.yaml"
    yaml_file.write_text(
        "languages: [de, fr, it]\n"
        "acts:\n"
        "  - sr: \"220\"\n"
        "    name: Code of Obligations\n"
        "    abbrev: OR / CO\n",
        encoding="utf-8",
    )
    corpus = load_corpus(yaml_file)
    assert corpus.languages == ["de", "fr", "it"]
    assert corpus.acts[0].sr == "220"
    assert corpus.acts[0].name == "Code of Obligations"


def test_load_real_corpus_file() -> None:
    corpus = load_corpus(REPO_ROOT / "corpus.yaml")
    assert len(corpus.acts) >= 10
    assert corpus.languages == ["de", "fr", "it"]
