"""Regression compare CLI: diffs two eval results JSON files row-by-row.

A metric regresses when it goes true -> false or numerically down between
the two runs; the reverse counts as an improvement. A metric that was never
scored (null) on either side is not comparable and is treated as unchanged.
Questions present in only one run are reported separately rather than mixed
into the regression/improvement counts.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

_METRICS = (
    "hit",
    "citation_precision",
    "citation_recall",
    "keyword_recall",
    "refusal_ok",
)


def _row_changes(old_row: dict, new_row: dict) -> tuple[list[dict], list[dict]]:
    regressions: list[dict] = []
    improvements: list[dict] = []

    for metric in _METRICS:
        old_value = old_row.get(metric)
        new_value = new_row.get(metric)

        if old_value is None or new_value is None or old_value == new_value:
            continue

        change = {"metric": metric, "old": old_value, "new": new_value}
        if isinstance(old_value, bool) and isinstance(new_value, bool):
            (regressions if old_value and not new_value else improvements).append(change)
        elif new_value < old_value:
            regressions.append(change)
        else:
            improvements.append(change)

    return regressions, improvements


def diff(old: dict, new: dict) -> list[dict]:
    """Compare two eval results dicts (as loaded from results JSON).

    Returns one row per question id, sorted by id, each shaped as either
    `{"id", "status": "only_in_old" | "only_in_new"}` or
    `{"id", "status": "regression" | "improvement" | "unchanged",
      "regressions": [...], "improvements": [...]}`.
    """
    old_rows = {row["id"]: row for row in old["questions"]}
    new_rows = {row["id"]: row for row in new["questions"]}

    rows: list[dict] = []
    for qid in old_rows.keys() | new_rows.keys():
        if qid not in new_rows:
            rows.append({"id": qid, "status": "only_in_old"})
            continue
        if qid not in old_rows:
            rows.append({"id": qid, "status": "only_in_new"})
            continue

        regressions, improvements = _row_changes(old_rows[qid], new_rows[qid])
        status = "regression" if regressions else "improvement" if improvements else "unchanged"
        rows.append(
            {
                "id": qid,
                "status": status,
                "regressions": regressions,
                "improvements": improvements,
            }
        )

    return sorted(rows, key=lambda row: row["id"])


def _format_change(question_id: str, change: dict) -> str:
    return f"  {question_id}: {change['metric']} {change['old']} -> {change['new']}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compare two eval results JSON files and report per-question regressions."
    )
    parser.add_argument("old", type=Path, help="path to the baseline results JSON")
    parser.add_argument("new", type=Path, help="path to the new results JSON")
    args = parser.parse_args(argv)

    old = json.loads(args.old.read_text(encoding="utf-8"))
    new = json.loads(args.new.read_text(encoding="utf-8"))

    rows = diff(old, new)
    compared = [row for row in rows if "regressions" in row]
    only_old = [row for row in rows if row["status"] == "only_in_old"]
    only_new = [row for row in rows if row["status"] == "only_in_new"]

    regression_count = 0
    print("Regressions:")
    for row in compared:
        for change in row["regressions"]:
            print(_format_change(row["id"], change))
            regression_count += 1
    if regression_count == 0:
        print("  none")

    improvement_count = 0
    print("Improvements:")
    for row in compared:
        for change in row["improvements"]:
            print(_format_change(row["id"], change))
            improvement_count += 1
    if improvement_count == 0:
        print("  none")

    if only_old:
        print(f"Only in old run: {', '.join(row['id'] for row in only_old)}")
    if only_new:
        print(f"Only in new run: {', '.join(row['id'] for row in only_new)}")

    print(
        f"\n{regression_count} regression(s), {improvement_count} improvement(s), "
        f"{len(compared)} question(s) compared "
        f"({len(only_old)} only in old, {len(only_new)} only in new)"
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
