from fastapi.testclient import TestClient

from retrieval.app import create_app
from tests.test_search import deps_with


class FakeThread:
    """is_alive() pops a scripted sequence; empty list = dead."""

    def __init__(self, alive: list[bool]) -> None:
        self._alive = alive

    def is_alive(self) -> bool:
        return self._alive.pop(0) if self._alive else False


def make_client() -> tuple[TestClient, object]:
    app = create_app()
    app.state.deps = deps_with([])  # prevents real DB connect in lifespan
    return TestClient(app), app


def parse_frames(text: str) -> list[tuple[str, str]]:
    frames = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        frames.append((lines["event"], lines["data"]))
    return frames


def test_ingest_status_returns_snapshot(monkeypatch) -> None:
    snapshot = {
        "running": False,
        "phase": None,
        "acts": 10,
        "chunks_total": 12930,
        "chunks_embedded": 12930,
    }
    monkeypatch.setattr("retrieval.app.ingest_status", lambda state, url: snapshot)
    client, _ = make_client()
    with client:
        response = client.get("/ingest/status")
    assert response.status_code == 200
    assert response.json() == snapshot


def test_post_ingest_starts_and_returns_202(monkeypatch) -> None:
    started: list[object] = []
    monkeypatch.setattr(
        "retrieval.app.start_ingest", lambda state, python: started.append(python) or True
    )
    client, _ = make_client()
    with client:
        response = client.post("/ingest")
    assert response.status_code == 202
    assert response.json() == {"status": "started"}
    assert len(started) == 1


def test_post_ingest_conflicts_while_running(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.app.start_ingest", lambda state, python: False)
    client, _ = make_client()
    with client:
        response = client.post("/ingest")
    assert response.status_code == 409
    assert "already active" in response.json()["detail"]


def test_progress_idle_emits_snapshot_then_done(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.app.phase_progress", lambda phase, url: (7, 9))
    monkeypatch.setattr("retrieval.app.embedded_count", lambda url: 7)
    client, _ = make_client()
    with client:
        response = client.get("/ingest/progress")
    frames = parse_frames(response.text)
    assert frames == [
        ("progress", '{"phase": "embed", "done": 7, "total": 9}'),
        ("done", '{"chunks_embedded": 7}'),
    ]


def test_progress_streams_while_running_then_done(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.app.phase_progress", lambda phase, url: (1, 2))
    monkeypatch.setattr("retrieval.app.embedded_count", lambda url: 2)
    monkeypatch.setattr("time.sleep", lambda seconds: None)
    client, app = make_client()
    app.state.ingest.thread = FakeThread([True, False])
    app.state.ingest.phase = "embed"
    with client:
        response = client.get("/ingest/progress")
    frames = parse_frames(response.text)
    events = [event for event, _ in frames]
    assert events == ["progress", "progress", "done"]


def test_progress_streams_live_phase_while_running(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.app.phase_progress", lambda phase, url: (1, 3))
    monkeypatch.setattr("retrieval.app.embedded_count", lambda url: 3)
    monkeypatch.setattr("time.sleep", lambda seconds: None)
    client, app = make_client()
    app.state.ingest.thread = FakeThread([True, False])
    app.state.ingest.phase = "fetch"
    with client:
        response = client.get("/ingest/progress")
    frames = parse_frames(response.text)
    assert frames[0] == ("progress", '{"phase": "fetch", "done": 1, "total": 3}')


def test_progress_ends_with_error_event_after_failed_run(monkeypatch) -> None:
    monkeypatch.setattr("retrieval.app.phase_progress", lambda phase, url: (0, 3))
    client, app = make_client()
    app.state.ingest.thread = FakeThread([])  # dead
    app.state.ingest.error = "`ingest fetch` failed (exit 1): BOOM"
    with client:
        response = client.get("/ingest/progress")
    frames = parse_frames(response.text)
    assert frames[-1] == ("error", '{"detail": "`ingest fetch` failed (exit 1): BOOM"}')
