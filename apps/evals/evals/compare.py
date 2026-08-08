"""Regression compare CLI: diffs two eval results JSON files row-by-row.

A metric regresses when it goes true -> false or numerically down between
the two runs; the reverse counts as an improvement. A metric that was never
scored (null) on either side is not comparable and is treated as unchanged.
Questions present in only one run are reported separately rather than mixed
into the regression/improvement counts.

`--latest` picks the two most recent `eval_*.json` files (by mtime) in
`--out-dir` instead of requiring explicit paths. When both runs carry a
`run_manifest` (older results predate that field and simply have none), a
mismatched `chat_model` or `eval_set_sha256` prints a warning before the
diff -- the two runs may not be an apples-to-apples comparison.
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


def _latest_two(out_dir: Path) -> tuple[Path, Path] | None:
    """The two most recently modified `eval_*.json` files in `out_dir`,
    oldest first, or `None` if fewer than two exist (including a missing
    `out_dir` -- `Path.glob` on a nonexistent directory yields nothing)."""
    candidates = sorted(out_dir.glob("eval_*.json"), key=lambda p: p.stat().st_mtime)
    if len(candidates) < 2:
        return None
    return candidates[-2], candidates[-1]


_MANIFEST_WARN_FIELDS = ("chat_model", "eval_set_sha256")


def _manifest_mismatch_warning(old: dict, new: dict) -> str | None:
    old_manifest = old.get("run_manifest")
    new_manifest = new.get("run_manifest")
    if not old_manifest or not new_manifest:
        return None

    mismatched = [
        field
        for field in _MANIFEST_WARN_FIELDS
        if old_manifest.get(field) != new_manifest.get(field)
    ]
    if not mismatched:
        return None
    return (
        f"WARNING: runs differ in {', '.join(mismatched)} -- "
        "comparison may not be apples-to-apples"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compare two eval results JSON files and report per-question regressions."
    )
    parser.add_argument(
        "old", type=Path, nargs="?", help="path to the baseline results JSON"
    )
    parser.add_argument("new", type=Path, nargs="?", help="path to the new results JSON")
    parser.add_argument(
        "--latest",
        action="store_true",
        help="compare the two most recent eval_*.json files in --out-dir instead of "
        "explicit paths",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("results"),
        help="directory to search when using --latest (default: results)",
    )
    args = parser.parse_args(argv)

    if args.latest:
        found = _latest_two(args.out_dir)
        if found is None:
            count = len(list(args.out_dir.glob("eval_*.json"))) if args.out_dir.exists() else 0
            print(
                f"--latest requires at least two eval_*.json files in {args.out_dir}, "
                f"found {count}"
            )
            return 1
        old_path, new_path = found
    else:
        if args.old is None or args.new is None:
            print("old and new paths are required unless --latest is given")
            return 1
        old_path, new_path = args.old, args.new

    old = json.loads(old_path.read_text(encoding="utf-8"))
    new = json.loads(new_path.read_text(encoding="utf-8"))

    warning = _manifest_mismatch_warning(old, new)
    if warning is not None:
        print(warning)

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
