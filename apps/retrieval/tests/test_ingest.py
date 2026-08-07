import json
import threading
from pathlib import Path

import psycopg
import pytest

from retrieval.ingest import (
    PHASES,
    IngestState,
    embedded_count,
    ingest_status,
    ingestion_python,
    phase_progress,
    start_ingest,
)


class FakeResult:
    def __init__(self, returncode: int = 0, stderr: str = "", stdout: str = "") -> None:
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = stdout


def make_data(repo_root: Path) -> None:
    entries = [
        {"sr": "220", "lang": "de"},
        {"sr": "220", "lang": "fr"},
        {"sr": "210", "lang": "de"},
    ]
    (repo_root / "data").mkdir()
    (repo_root / "data" / "manifest.json").write_text(
        json.dumps({"entries": entries}), encoding="utf-8"
    )
    (repo_root / "data" / "raw" / "220").mkdir(parents=True)
    (repo_root / "data" / "raw" / "220" / "de.xml").write_text("<x/>", encoding="utf-8")
    (repo_root / "data" / "chunks" / "220").mkdir(parents=True)
    (repo_root / "data" / "chunks" / "220" / "de.jsonl").write_text(
        '{"a": 1}\n{"a": 2}\n', encoding="utf-8"
    )


def test_ingest_status_counts_from_files_and_db(tmp_path: Path, monkeypatch) -> None:
    make_data(tmp_path)
    monkeypatch.setattr("retrieval.ingest.embedded_count", lambda url: 1)
    status = ingest_status(IngestState(), "postgresql://ignored", repo_root=tmp_path)
    assert status == {
        "running": False,
        "phase": None,
        "acts": 2,
        "chunks_total": 2,
        "chunks_embedded": 1,
    }


def test_ingest_status_all_zero_before_first_run(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("retrieval.ingest.embedded_count", lambda url: 0)
    status = ingest_status(IngestState(), "postgresql://ignored", repo_root=tmp_path)
    assert status == {
        "running": False,
        "phase": None,
        "acts": 0,
        "chunks_total": 0,
        "chunks_embedded": 0,
    }


def test_embedded_count_returns_zero_when_db_unreachable(monkeypatch) -> None:
    def dead_connect(url: str):
        raise psycopg.OperationalError("connection refused")

    monkeypatch.setattr("retrieval.ingest.psycopg.connect", dead_connect)
    assert embedded_count("postgresql://down") == 0


def test_embedded_count_filters_null_embeddings(monkeypatch) -> None:
    recorded_sql: list[str] = []

    class FakeCursor:
        def fetchone(self) -> tuple[int]:
            return (5,)

    class FakeConnection:
        def execute(self, sql: str) -> FakeCursor:
            recorded_sql.append(sql)
            return FakeCursor()

        def __enter__(self) -> "FakeConnection":
            return self

        def __exit__(self, *exc_info: object) -> None:
            return None

    def fake_connect(url: str) -> FakeConnection:
        return FakeConnection()

    monkeypatch.setattr("retrieval.ingest.psycopg.connect", fake_connect)
    assert embedded_count("postgresql://x") == 5
    assert len(recorded_sql) == 1
    assert "WHERE embedding IS NOT NULL" in recorded_sql[0]


def test_phase_progress_per_phase(tmp_path: Path, monkeypatch) -> None:
    make_data(tmp_path)
    monkeypatch.setattr("retrieval.ingest.embedded_count", lambda url: 1)
    url = "postgresql://ignored"
    assert phase_progress("resolve", url, repo_root=tmp_path) == (3, 3)
    assert phase_progress("fetch", url, repo_root=tmp_path) == (1, 3)
    assert phase_progress("parse", url, repo_root=tmp_path) == (1, 3)
    assert phase_progress("embed", url, repo_root=tmp_path) == (1, 2)


def test_phase_progress_rejects_unknown_phase(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unknown phase"):
        phase_progress("compile", "postgresql://ignored", repo_root=tmp_path)


def test_start_ingest_runs_all_phases_in_order(tmp_path: Path) -> None:
    commands: list[list[str]] = []

    def fake_run(cmd, cwd, capture_output, text):  # noqa: ANN001 - signature fixed by subprocess.run
        commands.append([str(part) for part in cmd])
        assert cwd == tmp_path
        return FakeResult()

    state = IngestState()
    assert start_ingest(state, Path("py"), repo_root=tmp_path, run=fake_run) is True
    assert state.thread is not None
    state.thread.join(timeout=5)
    assert [cmd[-1] for cmd in commands] == list(PHASES)
    assert all(cmd[:3] == ["py", "-m", "ingestion.cli"] for cmd in commands)
    assert state.error is None
    assert state.running is False
    assert state.phase is None


def test_start_ingest_stops_on_failure_and_keeps_stderr_tail(tmp_path: Path) -> None:
    commands: list[str] = []

    def fake_run(cmd, cwd, capture_output, text):  # noqa: ANN001
        commands.append(cmd[-1])
        if cmd[-1] == "fetch":
            return FakeResult(returncode=1, stderr="x" * 3000 + "BOOM")
        return FakeResult()

    state = IngestState()
    start_ingest(state, Path("py"), repo_root=tmp_path, run=fake_run)
    assert state.thread is not None
    state.thread.join(timeout=5)
    assert commands == ["resolve", "fetch"]  # parse/embed never ran
    assert state.error is not None
    assert "`ingest fetch` failed (exit 1)" in state.error
    assert state.error.endswith("BOOM")
    assert len(state.error) < 2200  # tail only, not the full 3000-char stderr


def test_start_ingest_refuses_second_concurrent_run(tmp_path: Path) -> None:
    release = threading.Event()

    def blocking_run(cmd, cwd, capture_output, text):  # noqa: ANN001
        release.wait(timeout=5)
        return FakeResult()

    state = IngestState()
    assert start_ingest(state, Path("py"), repo_root=tmp_path, run=blocking_run) is True
    assert start_ingest(state, Path("py"), repo_root=tmp_path, run=blocking_run) is False
    release.set()
    assert state.thread is not None
    state.thread.join(timeout=5)


def test_start_ingest_records_error_when_run_raises(tmp_path: Path) -> None:
    def broken_run(cmd, cwd, capture_output, text):  # noqa: ANN001
        raise FileNotFoundError("no such python")

    state = IngestState()
    assert start_ingest(state, Path("py"), repo_root=tmp_path, run=broken_run) is True
    assert state.thread is not None
    state.thread.join(timeout=5)
    assert state.error is not None
    assert "could not run" in state.error
    assert "no such python" in state.error
    assert state.running is False


def test_ingestion_python_explicit_setting_wins() -> None:
    assert ingestion_python("C:/custom/python.exe") == Path("C:/custom/python.exe")


def test_ingestion_python_default_points_into_ingestion_venv() -> None:
    default = ingestion_python("")
    assert "ingestion" in default.parts
    assert default.name.startswith("python")
