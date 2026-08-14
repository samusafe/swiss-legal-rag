import json
import sys
import threading
import time
from pathlib import Path

import psycopg
import pytest

from retrieval.ingest import (
    PHASES,
    IngestState,
    _run_via_popen,
    embedded_count,
    ingest_status,
    ingestion_python,
    phase_progress,
    start_ingest,
    stop_ingest,
)


class FakeResult:
    def __init__(self, returncode: int = 0, stderr: str = "", stdout: str = "") -> None:
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = stdout


def make_data(repo_root: Path) -> None:
    # data/raw/<jurisdiction>/<number>/<lang>.xml (fedlex),
    # data/chunks/<jurisdiction>/<number>/<lang>.jsonl
    entries = [
        {"jurisdiction": "CH", "number": "220", "lang": "de", "source": "fedlex"},
        {"jurisdiction": "CH", "number": "220", "lang": "fr", "source": "fedlex"},
        {"jurisdiction": "CH", "number": "210", "lang": "de", "source": "fedlex"},
    ]
    (repo_root / "data").mkdir()
    (repo_root / "data" / "manifest.json").write_text(
        json.dumps({"entries": entries}), encoding="utf-8"
    )
    (repo_root / "data" / "raw" / "CH" / "220").mkdir(parents=True)
    (repo_root / "data" / "raw" / "CH" / "220" / "de.xml").write_text("<x/>", encoding="utf-8")
    (repo_root / "data" / "chunks" / "CH" / "220").mkdir(parents=True)
    (repo_root / "data" / "chunks" / "CH" / "220" / "de.jsonl").write_text(
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


def test_phase_progress_fetch_counts_lexwork_json_alongside_fedlex_xml(
    tmp_path: Path, monkeypatch
) -> None:
    entries = [
        {"jurisdiction": "CH", "number": "220", "lang": "de", "source": "fedlex"},
        {"jurisdiction": "SG", "number": "811.1", "lang": "de", "source": "lexwork"},
    ]
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "manifest.json").write_text(
        json.dumps({"entries": entries}), encoding="utf-8"
    )
    (tmp_path / "data" / "raw" / "CH" / "220").mkdir(parents=True)
    (tmp_path / "data" / "raw" / "CH" / "220" / "de.xml").write_text("<x/>", encoding="utf-8")
    (tmp_path / "data" / "raw" / "SG").mkdir(parents=True)
    (tmp_path / "data" / "raw" / "SG" / "811.1.de.json").write_text("{}", encoding="utf-8")

    assert phase_progress("fetch", "postgresql://ignored", repo_root=tmp_path) == (2, 2)


def test_ingest_status_counts_acts_as_distinct_jurisdiction_number_pairs(
    tmp_path: Path, monkeypatch
) -> None:
    # Same act "number" in two different jurisdictions must count as two acts.
    entries = [
        {"jurisdiction": "SG", "number": "111.1", "lang": "de", "source": "lexwork"},
        {"jurisdiction": "BE", "number": "111.1", "lang": "de", "source": "lexwork"},
    ]
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "manifest.json").write_text(
        json.dumps({"entries": entries}), encoding="utf-8"
    )
    monkeypatch.setattr("retrieval.ingest.embedded_count", lambda url: 0)
    status = ingest_status(IngestState(), "postgresql://ignored", repo_root=tmp_path)
    assert status["acts"] == 2


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


def test_start_ingest_reports_user_stop_as_cancelled_not_a_crash(tmp_path: Path) -> None:
    # Drives the common case the between-phases-gap test above does not
    # cover: Stop is pressed while a phase's subprocess is genuinely live.
    # stop_ingest() terminates it, the terminated process then exits
    # nonzero (as a real killed subprocess would) — the terminal state must
    # read as a user cancellation, not the generic "failed (exit N)" message.
    commands: list[str] = []
    reached_fetch = threading.Event()
    terminated = threading.Event()

    class FakeProcess:
        def terminate(self) -> None:
            terminated.set()

    state = IngestState()

    def fake_run(cmd, cwd, capture_output, text):  # noqa: ANN001
        commands.append(cmd[-1])
        if cmd[-1] == "fetch":
            state.process = FakeProcess()
            reached_fetch.set()
            terminated.wait(timeout=5)
            return FakeResult(returncode=1, stderr="terminated")
        return FakeResult()

    assert start_ingest(state, Path("py"), repo_root=tmp_path, run=fake_run) is True
    assert reached_fetch.wait(timeout=5)

    assert stop_ingest(state) is True
    assert terminated.wait(timeout=5)

    assert state.thread is not None
    state.thread.join(timeout=5)

    assert commands == ["resolve", "fetch"]  # parse/embed never ran
    assert state.error == "ingest stopped by request"
    assert state.running is False


def test_start_ingest_keeps_genuine_failure_when_stop_not_requested(tmp_path: Path) -> None:
    # Same nonzero-exit shape as a Stop-triggered kill, but nobody called
    # stop_ingest — must stay a real failure message, not get reclassified
    # as a cancellation just because a later phase happens to fail.
    def fake_run(cmd, cwd, capture_output, text):  # noqa: ANN001
        if cmd[-1] == "fetch":
            return FakeResult(returncode=1, stderr="disk full")
        return FakeResult()

    state = IngestState()
    start_ingest(state, Path("py"), repo_root=tmp_path, run=fake_run)
    assert state.thread is not None
    state.thread.join(timeout=5)

    assert state.stop_requested is False
    assert state.error is not None
    assert "`ingest fetch` failed (exit 1)" in state.error
    assert "disk full" in state.error


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


def test_stop_ingest_returns_false_when_no_run_active() -> None:
    assert stop_ingest(IngestState()) is False


def test_stop_ingest_terminates_the_active_process_and_returns_true() -> None:
    class FakeProcess:
        def __init__(self) -> None:
            self.terminated = False

        def terminate(self) -> None:
            self.terminated = True

    release = threading.Event()
    state = IngestState()
    state.thread = threading.Thread(target=release.wait)
    state.thread.start()
    process = FakeProcess()
    state.process = process

    assert stop_ingest(state) is True
    assert process.terminated is True

    release.set()
    state.thread.join(timeout=5)


def test_stop_ingest_aborts_before_the_next_phase_spawns(tmp_path: Path) -> None:
    # A run can be `running` between phases, briefly, after the previous
    # phase's subprocess has already exited and before the next one spawns —
    # stop_ingest must still stop the run, not just report it was active,
    # by latching stop_requested so _run_pipeline never spawns "fetch".
    commands: list[str] = []
    reached_gap = threading.Event()
    release = threading.Event()

    def fake_run(cmd, cwd, capture_output, text):  # noqa: ANN001
        commands.append(cmd[-1])
        if cmd[-1] == "resolve":
            reached_gap.set()
            release.wait(timeout=5)
        return FakeResult()

    state = IngestState()
    assert start_ingest(state, Path("py"), repo_root=tmp_path, run=fake_run) is True
    assert reached_gap.wait(timeout=5)

    assert stop_ingest(state) is True  # no live process here — the between-phases gap

    release.set()
    assert state.thread is not None
    state.thread.join(timeout=5)

    assert commands == ["resolve"]  # fetch/parse/embed never spawned
    assert state.error == "ingest stopped by request"
    assert state.running is False


def test_run_via_popen_tracks_and_clears_the_process_on_state(tmp_path: Path) -> None:
    state = IngestState()
    result = _run_via_popen(
        state,
        [sys.executable, "-c", "print('hi')"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == "hi"
    assert state.process is None  # cleared once the subprocess has exited


def test_run_via_popen_process_is_terminated_by_stop_ingest(tmp_path: Path) -> None:
    state = IngestState()

    def target() -> None:
        _run_via_popen(
            state,
            [sys.executable, "-c", "import time; time.sleep(30)"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
        )

    state.thread = threading.Thread(target=target)
    state.thread.start()
    for _ in range(50):  # up to 5s for the child process to spawn and register
        if state.process is not None:
            break
        time.sleep(0.1)
    assert state.process is not None

    assert stop_ingest(state) is True

    state.thread.join(timeout=5)
    assert state.thread.is_alive() is False
    assert state.process is None


def test_start_ingest_default_run_uses_popen(monkeypatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []

    class FakePopen:
        def __init__(self, cmd, cwd, stdout, stderr, text) -> None:  # noqa: ANN001
            calls.append([str(part) for part in cmd])
            self.returncode = 0

        def communicate(self) -> tuple[str, str]:
            return "", ""

    monkeypatch.setattr("retrieval.ingest.subprocess.Popen", FakePopen)
    state = IngestState()

    assert start_ingest(state, Path("py"), repo_root=tmp_path) is True
    assert state.thread is not None
    state.thread.join(timeout=5)

    assert [cmd[-1] for cmd in calls] == list(PHASES)
    assert state.error is None
    assert state.process is None
