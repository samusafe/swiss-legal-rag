import json
import os
import subprocess
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import psycopg

RunFn = Callable[..., subprocess.CompletedProcess[str]]

PHASES: tuple[str, ...] = ("resolve", "fetch", "parse", "embed")

# <repo>/apps/retrieval/retrieval/ingest.py -> <repo>
REPO_ROOT = Path(__file__).resolve().parents[3]

STDERR_TAIL_CHARS = 2000


@dataclass
class IngestState:
    """One ingest run at a time, shared across requests via app.state."""

    lock: threading.Lock = field(default_factory=threading.Lock)
    phase: str | None = None
    error: str | None = None
    thread: threading.Thread | None = None

    @property
    def running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()


def ingestion_python(setting: str) -> Path:
    if setting:
        return Path(setting)
    interpreter = "Scripts/python.exe" if os.name == "nt" else "bin/python"
    return REPO_ROOT / "apps" / "ingestion" / ".venv" / interpreter


def embedded_count(database_url: str) -> int:
    # Deliberate zero-on-unreachable (spec): the modal must render before
    # `docker compose up`; a real run's embed step still fails loud via the
    # error event.
    try:
        with psycopg.connect(database_url) as conn:
            row = conn.execute(
                "SELECT count(*) FROM chunks WHERE embedding IS NOT NULL"
            ).fetchone()
            return int(row[0]) if row is not None else 0
    except psycopg.Error:
        return 0


def _manifest_entries(repo_root: Path) -> list[dict]:
    manifest = repo_root / "data" / "manifest.json"
    if not manifest.exists():
        return []
    return json.loads(manifest.read_text(encoding="utf-8"))["entries"]


def _chunk_lines(repo_root: Path) -> int:
    total = 0
    for path in sorted((repo_root / "data" / "chunks").glob("*/*.jsonl")):
        with path.open(encoding="utf-8") as handle:
            total += sum(1 for line in handle if line.strip())
    return total


def ingest_status(state: IngestState, database_url: str, repo_root: Path = REPO_ROOT) -> dict:
    with state.lock:
        running = state.running
        phase = state.phase if running else None
    entries = _manifest_entries(repo_root)
    return {
        "running": running,
        "phase": phase,
        "acts": len({entry["sr"] for entry in entries}),
        "chunks_total": _chunk_lines(repo_root),
        "chunks_embedded": embedded_count(database_url),
    }


def phase_progress(
    phase: str, database_url: str, repo_root: Path = REPO_ROOT
) -> tuple[int, int]:
    entries = len(_manifest_entries(repo_root))
    if phase == "resolve":
        # The manifest is written in one shot at step end; a pre-existing
        # manifest shows as full — the resolve step only lasts ~30-60 s.
        return entries, entries
    if phase == "fetch":
        return len(list((repo_root / "data" / "raw").glob("*/*.xml"))), entries
    if phase == "parse":
        return len(list((repo_root / "data" / "chunks").glob("*/*.jsonl"))), entries
    if phase == "embed":
        return embedded_count(database_url), _chunk_lines(repo_root)
    raise ValueError(f"unknown phase: {phase}")


def _run_pipeline(state: IngestState, python: Path, repo_root: Path, run: RunFn) -> None:
    phase = PHASES[0]
    try:
        for phase in PHASES:
            with state.lock:
                state.phase = phase
            result = run(
                [str(python), "-m", "ingestion.cli", phase],
                cwd=repo_root,
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                # some steps report failures on stdout, so fall back to it for the tail
                tail = (result.stderr or result.stdout or "")[-STDERR_TAIL_CHARS:]
                with state.lock:
                    state.error = (
                        f"`ingest {phase}` failed (exit {result.returncode}): {tail}"
                    )
                return
    except Exception as error:  # interpreter missing, bad path, undecodable output
        with state.lock:
            state.error = f"`ingest {phase}` could not run: {error}"
    finally:
        with state.lock:
            state.phase = None


def start_ingest(
    state: IngestState,
    python: Path,
    repo_root: Path = REPO_ROOT,
    run: RunFn = subprocess.run,
) -> bool:
    with state.lock:
        if state.thread is not None and state.thread.is_alive():
            return False
        state.error = None
        thread = threading.Thread(
            target=_run_pipeline, args=(state, python, repo_root, run), daemon=True
        )
        state.thread = thread
        thread.start()
    return True
