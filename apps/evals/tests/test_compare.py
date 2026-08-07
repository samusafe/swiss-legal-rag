import json
from pathlib import Path

from evals.compare import diff, main


def _result(rows: list[dict]) -> dict:
    return {"questions": rows}


def _row(id_: str, **overrides) -> dict:
    base = {
        "id": id_,
        "hit": None,
        "citation_precision": None,
        "citation_recall": None,
        "keyword_recall": None,
        "refusal_ok": None,
    }
    base.update(overrides)
    return base


def test_diff_flags_regression_when_hit_goes_true_to_false():
    old = _result([_row("q1", hit=True)])
    new = _result([_row("q1", hit=False)])

    rows = diff(old, new)

    assert len(rows) == 1
    assert rows[0]["id"] == "q1"
    assert rows[0]["status"] == "regression"
    assert rows[0]["regressions"] == [{"metric": "hit", "old": True, "new": False}]
    assert rows[0]["improvements"] == []


def test_diff_flags_improvement_when_metric_numerically_up():
    old = _result([_row("q1", citation_precision=0.5)])
    new = _result([_row("q1", citation_precision=1.0)])

    rows = diff(old, new)

    assert rows[0]["status"] == "improvement"
    assert rows[0]["improvements"] == [
        {"metric": "citation_precision", "old": 0.5, "new": 1.0}
    ]
    assert rows[0]["regressions"] == []


def test_diff_marks_unchanged_when_no_metric_changes():
    row = _row("q1", hit=True, citation_precision=1.0, citation_recall=1.0, keyword_recall=1.0)

    rows = diff(_result([dict(row)]), _result([dict(row)]))

    assert rows[0]["status"] == "unchanged"
    assert rows[0]["regressions"] == []
    assert rows[0]["improvements"] == []


def test_diff_lists_id_only_in_new_run_separately():
    old = _result([])
    new = _result([_row("q1", hit=True)])

    rows = diff(old, new)

    assert len(rows) == 1
    assert rows[0]["id"] == "q1"
    assert rows[0]["status"] == "only_in_new"


def test_diff_lists_id_only_in_old_run_separately():
    old = _result([_row("q1", hit=True)])
    new = _result([])

    rows = diff(old, new)

    assert len(rows) == 1
    assert rows[0]["id"] == "q1"
    assert rows[0]["status"] == "only_in_old"


def test_diff_treats_numeric_decrease_as_regression():
    old = _result([_row("q1", keyword_recall=1.0)])
    new = _result([_row("q1", keyword_recall=0.0)])

    rows = diff(old, new)

    assert rows[0]["status"] == "regression"
    assert rows[0]["regressions"] == [{"metric": "keyword_recall", "old": 1.0, "new": 0.0}]


def test_diff_ignores_metric_that_was_never_scored_on_either_side():
    old = _result([_row("q1", citation_precision=None)])
    new = _result([_row("q1", citation_precision=0.5)])

    rows = diff(old, new)

    # newly scored (was null before) is not a comparable regression/improvement
    assert rows[0]["status"] == "unchanged"


def test_main_prints_regressions_then_improvements_then_counts_and_returns_zero(
    tmp_path: Path, capsys
):
    old = _result(
        [
            _row("q1", hit=True),
            _row("q2", citation_precision=0.5),
            _row("q3", hit=True),
        ]
    )
    new = _result(
        [
            _row("q1", hit=False),
            _row("q2", citation_precision=1.0),
            _row("q3", hit=True),
            _row("q4", hit=True),
        ]
    )
    old_path = tmp_path / "old.json"
    new_path = tmp_path / "new.json"
    old_path.write_text(json.dumps(old), encoding="utf-8")
    new_path.write_text(json.dumps(new), encoding="utf-8")

    exit_code = main([str(old_path), str(new_path)])

    captured = capsys.readouterr()
    regressions_idx = captured.out.index("Regressions")
    improvements_idx = captured.out.index("Improvements")
    assert regressions_idx < improvements_idx
    assert "q1" in captured.out
    assert "q2" in captured.out
    assert "1 regression" in captured.out
    assert "1 improvement" in captured.out
    assert "q4" in captured.out
    assert exit_code == 0


def test_main_prints_improvements_from_a_regression_row(tmp_path: Path, capsys):
    """A row can be an overall 'regression' (diff() picks that status because
    it has >=1 regression entry) while still carrying its own improvement
    entries -- those must still be printed, not swallowed by the status
    filter."""
    old = _result([_row("q1", hit=True, citation_precision=0.5)])
    new = _result([_row("q1", hit=False, citation_precision=1.0)])
    old_path = tmp_path / "old.json"
    new_path = tmp_path / "new.json"
    old_path.write_text(json.dumps(old), encoding="utf-8")
    new_path.write_text(json.dumps(new), encoding="utf-8")

    exit_code = main([str(old_path), str(new_path)])

    captured = capsys.readouterr()
    assert "q1: hit True -> False" in captured.out
    assert "q1: citation_precision 0.5 -> 1.0" in captured.out
    assert exit_code == 0


def test_main_counts_metric_changes_not_rows(tmp_path: Path, capsys):
    """The tally line counts individual metric-change entries, matching what
    is actually printed above it -- not the number of rows in each status
    bucket. A single row can carry multiple regression or improvement
    entries."""
    old = _result(
        [
            _row("q1", hit=True),
            _row("q2", citation_precision=0.5),
            _row("q3", keyword_recall=1.0, citation_recall=1.0),
        ]
    )
    new = _result(
        [
            _row("q1", hit=False),
            _row("q2", citation_precision=1.0),
            _row("q3", keyword_recall=0.0, citation_recall=0.5),
        ]
    )
    old_path = tmp_path / "old.json"
    new_path = tmp_path / "new.json"
    old_path.write_text(json.dumps(old), encoding="utf-8")
    new_path.write_text(json.dumps(new), encoding="utf-8")

    exit_code = main([str(old_path), str(new_path)])

    captured = capsys.readouterr()
    # q1 (hit) + q3 (keyword_recall, citation_recall) = 3 regression entries
    assert "3 regression(s)" in captured.out
    # q2 (citation_precision) = 1 improvement entry
    assert "1 improvement(s)" in captured.out
    assert exit_code == 0


def test_main_compared_count_excludes_only_in_old_and_only_in_new(
    tmp_path: Path, capsys
):
    """'N question(s) compared' should count only rows present in both runs,
    not rows that only exist on one side."""
    old = _result([_row("q1", hit=True), _row("q_old_only", hit=True)])
    new = _result([_row("q1", hit=False), _row("q_new_only", hit=True)])
    old_path = tmp_path / "old.json"
    new_path = tmp_path / "new.json"
    old_path.write_text(json.dumps(old), encoding="utf-8")
    new_path.write_text(json.dumps(new), encoding="utf-8")

    exit_code = main([str(old_path), str(new_path)])

    captured = capsys.readouterr()
    # only q1 was present in both runs and pairwise-compared
    assert "1 question(s) compared" in captured.out
    assert exit_code == 0
