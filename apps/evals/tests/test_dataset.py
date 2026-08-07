import json
from pathlib import Path

import pytest

from evals.dataset import GoldQuestion, load_gold


def _write(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "gold.jsonl"
    path.write_text(text, encoding="utf-8")
    return path


def _row(**overrides) -> dict:
    data = {
        "id": "q1",
        "lang": "de",
        "question": "Was ist ein Vertrag?",
        "expected_sources": ["SR 220 Art. 1"],
        "expected_keywords": ["Vertrag"],
        "must_refuse": False,
    }
    data.update(overrides)
    return data


def test_loads_valid_line_into_gold_question(tmp_path):
    path = _write(tmp_path, json.dumps(_row()) + "\n")

    questions = load_gold(path)

    assert questions == [
        GoldQuestion(
            id="q1",
            lang="de",
            question="Was ist ein Vertrag?",
            expected_sources=("SR 220 Art. 1",),
            expected_keywords=("Vertrag",),
            must_refuse=False,
        )
    ]


def test_skips_blank_and_comment_lines(tmp_path):
    valid = json.dumps(_row(id="q2", lang="fr", must_refuse=True))
    text = f"// a leading comment\n\n{valid}\n   \n// a trailing comment\n"
    path = _write(tmp_path, text)

    questions = load_gold(path)

    assert len(questions) == 1
    assert questions[0].id == "q2"
    assert questions[0].must_refuse is True


def test_bad_json_raises_value_error_naming_line_number(tmp_path):
    path = _write(tmp_path, "not json at all\n")

    with pytest.raises(ValueError, match=r"\b1\b"):
        load_gold(path)


def test_bad_json_on_later_line_reports_that_line_number(tmp_path):
    text = f"{json.dumps(_row())}\nnot json\n"
    path = _write(tmp_path, text)

    with pytest.raises(ValueError, match=r"\b2\b"):
        load_gold(path)


def test_missing_field_raises_value_error_naming_line_number(tmp_path):
    data = _row()
    del data["must_refuse"]
    path = _write(tmp_path, json.dumps(data) + "\n")

    with pytest.raises(ValueError, match=r"\b1\b"):
        load_gold(path)


def test_lang_not_in_de_fr_it_raises_value_error_naming_line_number(tmp_path):
    path = _write(tmp_path, json.dumps(_row(lang="en")) + "\n")

    with pytest.raises(ValueError, match=r"\b1\b"):
        load_gold(path)


def test_expected_sources_bare_string_raises_value_error_naming_line_number(tmp_path):
    # A bare string is iterable, so a naive tuple() would silently explode it
    # into single characters instead of rejecting it.
    path = _write(tmp_path, json.dumps(_row(expected_sources="SR 220 Art. 1")) + "\n")

    with pytest.raises(ValueError, match=r"\b1\b"):
        load_gold(path)


def test_expected_keywords_bare_string_raises_value_error_naming_line_number(tmp_path):
    path = _write(tmp_path, json.dumps(_row(expected_keywords="Vertrag")) + "\n")

    with pytest.raises(ValueError, match=r"\b1\b"):
        load_gold(path)


def test_must_refuse_string_false_raises_value_error_naming_line_number(tmp_path):
    path = _write(tmp_path, json.dumps(_row(must_refuse="false")) + "\n")

    with pytest.raises(ValueError, match=r"\b1\b"):
        load_gold(path)


def test_expected_sources_entry_bad_shape_raises_value_error_naming_line_number(tmp_path):
    path = _write(tmp_path, json.dumps(_row(expected_sources=["Art. 220 SR 1"])) + "\n")

    with pytest.raises(ValueError, match=r"\b1\b"):
        load_gold(path)
