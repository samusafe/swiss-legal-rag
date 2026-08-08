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


def test_unknown_key_raises_value_error_naming_line_and_key(tmp_path):
    data = _row()
    data["unexpected_field"] = "surprise"
    path = _write(tmp_path, json.dumps(data) + "\n")

    with pytest.raises(ValueError, match=r"line 1.*unexpected_field|unexpected_field.*line 1"):
        load_gold(path)


def test_unknown_key_error_names_multiple_offending_keys(tmp_path):
    data = _row()
    data["bogus_a"] = 1
    data["bogus_b"] = 2
    path = _write(tmp_path, json.dumps(data) + "\n")

    with pytest.raises(ValueError) as excinfo:
        load_gold(path)
    assert "bogus_a" in str(excinfo.value)
    assert "bogus_b" in str(excinfo.value)


def test_expected_source_ids_is_accepted_optional_key(tmp_path):
    data = _row(expected_source_ids=["upstream-id-1", "upstream-id-2"])
    path = _write(tmp_path, json.dumps(data) + "\n")

    questions = load_gold(path)

    assert questions[0].expected_source_ids == ("upstream-id-1", "upstream-id-2")


def test_expected_source_ids_defaults_to_empty_tuple_when_absent(tmp_path):
    path = _write(tmp_path, json.dumps(_row()) + "\n")

    questions = load_gold(path)

    assert questions[0].expected_source_ids == ()


def test_expected_source_ids_bare_string_raises_value_error(tmp_path):
    data = _row(expected_source_ids="not-a-list")
    path = _write(tmp_path, json.dumps(data) + "\n")

    with pytest.raises(ValueError, match=r"\b1\b"):
        load_gold(path)


def test_duplicate_id_raises_value_error_naming_both_line_numbers(tmp_path):
    row1 = json.dumps(_row(id="dup"))
    row2 = json.dumps(_row(id="dup", question="A different question?"))
    path = _write(tmp_path, f"{row1}\n{row2}\n")

    with pytest.raises(ValueError, match=r"\b1\b.*\b2\b|\b2\b.*\b1\b"):
        load_gold(path)


def test_blank_id_raises_value_error_naming_line_number(tmp_path):
    path = _write(tmp_path, json.dumps(_row(id="   ")) + "\n")

    with pytest.raises(ValueError, match=r"\b1\b"):
        load_gold(path)


def test_blank_question_raises_value_error_naming_line_number(tmp_path):
    path = _write(tmp_path, json.dumps(_row(question="")) + "\n")

    with pytest.raises(ValueError, match=r"\b1\b"):
        load_gold(path)


def test_permissive_mode_skips_bad_rows_and_logs_to_stderr(tmp_path, capsys):
    good = json.dumps(_row(id="good"))
    bad = json.dumps(_row(id="bad", lang="en"))
    path = _write(tmp_path, f"{good}\n{bad}\n")

    questions = load_gold(path, permissive=True)

    assert [q.id for q in questions] == ["good"]
    captured = capsys.readouterr()
    assert "skipping line 2" in captured.err


def test_permissive_mode_still_enforces_strict_rules_on_valid_rows(tmp_path):
    good = json.dumps(_row(id="good"))
    path = _write(tmp_path, f"{good}\n")

    questions = load_gold(path, permissive=True)

    assert len(questions) == 1


def test_permissive_mode_raises_when_no_valid_rows_remain(tmp_path):
    bad = json.dumps(_row(lang="en"))
    path = _write(tmp_path, f"{bad}\n")

    with pytest.raises(ValueError):
        load_gold(path, permissive=True)


def test_strict_mode_still_raises_on_first_bad_row_by_default(tmp_path):
    good = json.dumps(_row(id="good"))
    bad = json.dumps(_row(id="bad", lang="en"))
    path = _write(tmp_path, f"{good}\n{bad}\n")

    with pytest.raises(ValueError, match=r"\b2\b"):
        load_gold(path)
