import hashlib
import json
import subprocess
import sys
import types
from pathlib import Path

import httpx
import pytest

from evals.run import log_to_mlflow, main, run


def _write_dataset(tmp_path: Path) -> Path:
    rows = [
        {
            "id": "q1",
            "lang": "de",
            "question": "Frage eins",
            "expected_sources": ["SR 220 Art. 1"],
            "expected_keywords": [],
            "must_refuse": False,
        },
        {
            "id": "q2",
            "lang": "de",
            "question": "Frage zwei",
            "expected_sources": [],
            "expected_keywords": [],
            "must_refuse": False,
        },
    ]
    path = tmp_path / "gold.jsonl"
    path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
    return path


def test_run_writes_results_json_with_expected_shape_and_records_row_errors(tmp_path):
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/ingest/status":
            return httpx.Response(
                200, json={"acts": 3, "chunks_total": 100, "chunks_embedded": 100}
            )
        body = json.loads(request.content)
        if body["q"] == "Frage zwei":
            return httpx.Response(500, text="boom")
        return httpx.Response(
            200,
            json={
                "results": [{"collection": "SR", "number": "220", "article": "1"}],
                "took_ms": {"embed": 1},
            },
        )

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    out_path = run(
        dataset=dataset,
        mode="retrieval",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    assert out_path.exists()
    assert out_path.parent == out_dir
    assert out_path.name.startswith("eval_retrieval_")
    assert out_path.name.endswith(".json")

    data = json.loads(out_path.read_text(encoding="utf-8"))

    assert set(data) == {
        "mode",
        "model",
        "k",
        "dataset",
        "started",
        "corpus",
        "questions",
        "summary",
        "run_manifest",
    }
    assert data["corpus"] == {"acts": 3, "chunks_total": 100, "chunks_embedded": 100}
    assert data["mode"] == "retrieval"
    assert data["k"] == 5
    assert data["dataset"] == str(dataset)
    assert len(data["questions"]) == 2

    row_keys = {
        "id",
        "lang",
        "hit",
        "citation_precision",
        "citation_recall",
        "keyword_recall",
        "refusal_ok",
        "latency_s",
        "error",
    }
    for row in data["questions"]:
        assert set(row) == row_keys

    ok_row = next(r for r in data["questions"] if r["id"] == "q1")
    assert ok_row["hit"] is True
    assert ok_row["error"] is None

    errored_row = next(r for r in data["questions"] if r["id"] == "q2")
    assert errored_row["error"] is not None
    assert errored_row["hit"] is None

    summary_keys = {
        "hit_rate",
        "citation_precision",
        "citation_recall",
        "keyword_recall",
        "refusal_accuracy",
        "median_latency_s",
        "questions",
        "errors",
    }
    assert set(data["summary"]) == summary_keys
    assert data["summary"]["questions"] == 2
    assert data["summary"]["errors"] == 1


def _sse_body(events: list[tuple[str, dict]]) -> bytes:
    frames = [f"event: {event}\ndata: {json.dumps(data)}\n\n" for event, data in events]
    return "".join(frames).encode("utf-8")


def test_run_full_mode_calls_search_and_chat_and_scores_both(tmp_path):
    rows = [
        {
            "id": "q1",
            "lang": "de",
            "question": "Frage eins",
            "expected_sources": ["SR 220 Art. 1"],
            "expected_keywords": ["vertrag"],
            "must_refuse": False,
        },
        {
            "id": "q2",
            "lang": "de",
            "question": "Frage zwei",
            "expected_sources": [],
            "expected_keywords": [],
            "must_refuse": True,
        },
    ]
    dataset = tmp_path / "gold.jsonl"
    dataset.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if request.url.path == "/search":
            return httpx.Response(
                200,
                json={
                "results": [{"collection": "SR", "number": "220", "article": "1"}],
                "took_ms": {"embed": 1},
            },
            )
        assert request.url.path == "/chat"
        if body["question"] == "Frage eins":
            citation = {
                "raw": "[SR 220 Art. 1]",
                "collection": "SR",
                "number": "220",
                "article": "1",
                "citation_label": "SR 220 Art. 1",
                "source_url": "https://example.org/source",
                "resolved": True,
            }
            events = [
                ("token", {"delta": "Der Vertrag ist gültig"}),
                ("done", {"citations": [citation]}),
            ]
        else:
            events = [
                (
                    "token",
                    {
                        "delta": (
                            "The current corpus contains no sources sufficient "
                            "to answer this question."
                        )
                    },
                ),
                ("done", {"citations": []}),
            ]
        return httpx.Response(200, content=_sse_body(events))

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    out_path = run(
        dataset=dataset,
        mode="chat",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))

    q1 = next(r for r in data["questions"] if r["id"] == "q1")
    assert q1["hit"] is True
    assert q1["citation_precision"] == 1.0
    assert q1["citation_recall"] == 1.0
    assert q1["keyword_recall"] == 1.0
    assert q1["refusal_ok"] is None
    assert q1["error"] is None

    q2 = next(r for r in data["questions"] if r["id"] == "q2")
    assert q2["hit"] is None
    assert q2["citation_precision"] is None
    assert q2["citation_recall"] is None
    assert q2["keyword_recall"] is None
    assert q2["refusal_ok"] is True
    assert q2["error"] is None


def test_run_refusal_ok_false_when_zero_citations_but_answer_not_canonical(tmp_path):
    rows = [
        {
            "id": "q1",
            "lang": "de",
            "question": "Frage zwei",
            "expected_sources": [],
            "expected_keywords": [],
            "must_refuse": True,
        },
    ]
    dataset = tmp_path / "gold.jsonl"
    dataset.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/search":
            return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})
        events = [
            ("token", {"delta": "Ich kann das nicht beantworten"}),
            ("done", {"citations": []}),
        ]
        return httpx.Response(200, content=_sse_body(events))

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    out_path = run(
        dataset=dataset,
        mode="chat",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert data["questions"][0]["refusal_ok"] is False


def test_run_retrieval_only_mode_does_not_call_chat(tmp_path):
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path != "/chat"
        if request.url.path == "/ingest/status":
            return httpx.Response(200, json={"acts": 1})
        assert request.url.path == "/search"
        return httpx.Response(
            200,
            json={
                "results": [{"collection": "SR", "number": "220", "article": "1"}],
                "took_ms": {"embed": 1},
            },
        )

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    out_path = run(
        dataset=dataset,
        mode="retrieval",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))
    for row in data["questions"]:
        assert row["citation_precision"] is None
        assert row["citation_recall"] is None
        assert row["keyword_recall"] is None
        assert row["refusal_ok"] is None
        assert row["error"] is None


def test_run_corpus_is_null_when_ingest_status_fails(tmp_path):
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/ingest/status":
            return httpx.Response(500, text="boom")
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    out_path = run(
        dataset=dataset,
        mode="retrieval",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert data["corpus"] is None


def test_run_corpus_is_null_when_ingest_status_unreachable(tmp_path):
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/ingest/status":
            raise httpx.ConnectError("refused")
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    out_path = run(
        dataset=dataset,
        mode="retrieval",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert data["corpus"] is None


def test_run_stamps_model_field_from_ollama_chat_model_env(tmp_path, monkeypatch):
    monkeypatch.setenv("OLLAMA_CHAT_MODEL", "qwen3:8b")
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    out_path = run(
        dataset=dataset,
        mode="retrieval",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert data["model"] == "qwen3:8b"


def test_run_model_field_is_null_when_env_unset(tmp_path, monkeypatch):
    monkeypatch.delenv("OLLAMA_CHAT_MODEL", raising=False)
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    out_path = run(
        dataset=dataset,
        mode="retrieval",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert data["model"] is None


def test_log_to_mlflow_logs_params_metrics_and_artifact(tmp_path, monkeypatch):
    calls = {"params": None, "metrics": [], "artifacts": [], "started": False, "ended": False}

    class FakeRunCtx:
        def __enter__(self):
            calls["started"] = True
            return self

        def __exit__(self, *exc_info):
            calls["ended"] = True
            return False

    fake_mlflow = types.SimpleNamespace(
        start_run=lambda: FakeRunCtx(),
        log_params=lambda params: calls.__setitem__("params", params),
        log_metric=lambda key, value: calls["metrics"].append((key, value)),
        log_artifact=lambda path: calls["artifacts"].append(path),
    )
    monkeypatch.setitem(sys.modules, "mlflow", fake_mlflow)

    result = {
        "mode": "chat",
        "model": "qwen3:8b",
        "k": 5,
        "dataset": "data/gold.jsonl",
        "summary": {
            "hit_rate": 0.8,
            "citation_precision": None,
            "citation_recall": 0.5,
            "keyword_recall": None,
            "refusal_accuracy": 1.0,
            "median_latency_s": 1.2,
            "questions": 10,
            "errors": 0,
        },
    }
    out_path = tmp_path / "eval_chat_20260101-000000.json"
    out_path.write_text("{}", encoding="utf-8")

    log_to_mlflow(result, out_path)

    assert calls["started"] is True
    assert calls["ended"] is True
    assert calls["params"] == {
        "mode": "chat",
        "k": 5,
        "dataset": "data/gold.jsonl",
        "model": "qwen3:8b",
    }
    assert dict(calls["metrics"]) == {
        "hit_rate": 0.8,
        "citation_recall": 0.5,
        "refusal_accuracy": 1.0,
        "median_latency_s": 1.2,
        "questions": 10,
        "errors": 0,
    }
    assert calls["artifacts"] == [str(out_path)]


def test_run_sends_x_api_key_header_on_all_calls_when_env_set(tmp_path, monkeypatch):
    monkeypatch.setenv("API_KEY", "secret-key")
    rows = [
        {
            "id": "q1",
            "lang": "de",
            "question": "Frage eins",
            "expected_sources": [],
            "expected_keywords": [],
            "must_refuse": False,
        },
    ]
    dataset = tmp_path / "gold.jsonl"
    dataset.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    out_dir = tmp_path / "results"

    seen_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.append(request.headers.get("x-api-key"))
        if request.url.path == "/ingest/status":
            return httpx.Response(200, json={"acts": 1})
        if request.url.path == "/search":
            return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})
        assert request.url.path == "/chat"
        events = [("token", {"delta": "hi"}), ("done", {"citations": []})]
        return httpx.Response(200, content=_sse_body(events))

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    run(
        dataset=dataset,
        mode="chat",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    assert seen_headers  # at least one call was made
    assert all(header == "secret-key" for header in seen_headers)


def test_run_omits_x_api_key_header_when_env_unset(tmp_path, monkeypatch):
    monkeypatch.delenv("API_KEY", raising=False)
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"

    seen_headers: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.append(request.headers.get("x-api-key"))
        if request.url.path == "/ingest/status":
            return httpx.Response(200, json={"acts": 1})
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    run(
        dataset=dataset,
        mode="retrieval",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    assert seen_headers
    assert all(header is None for header in seen_headers)


def test_log_to_mlflow_raises_clear_error_when_mlflow_not_installed(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "mlflow", None)

    result = {
        "mode": "chat",
        "model": None,
        "k": 5,
        "dataset": "data/gold.jsonl",
        "summary": {},
    }

    with pytest.raises(RuntimeError, match="pip install mlflow"):
        log_to_mlflow(result, tmp_path / "eval.json")


def _stub_git_success(*args, **kwargs):
    argv = args[0]
    if argv[:2] == ["git", "rev-parse"]:
        return subprocess.CompletedProcess(argv, 0, stdout="a" * 40 + "\n", stderr="")
    if argv[:2] == ["git", "status"]:
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
    raise AssertionError(f"unexpected subprocess call: {argv}")


def test_run_manifest_has_expected_shape_and_values(tmp_path, monkeypatch):
    monkeypatch.setenv("OLLAMA_CHAT_MODEL", "qwen3:8b")
    monkeypatch.setenv("OLLAMA_EMBED_MODEL", "bge-m3")
    monkeypatch.setattr("evals.run.subprocess.run", _stub_git_success)
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(transport=transport)

    out_path = run(
        dataset=dataset,
        mode="retrieval",
        k=7,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))
    manifest = data["run_manifest"]

    assert manifest["schema_version"] == 1
    assert manifest["timestamp_utc"]  # ISO8601 string, non-empty
    assert manifest["git"] == {"commit_sha": "a" * 40, "dirty": False}
    assert manifest["eval_set_sha256"] == hashlib.sha256(dataset.read_bytes()).hexdigest()
    assert manifest["chat_model"] == "qwen3:8b"
    assert manifest["embedding_model"] == "bge-m3"
    assert manifest["retrieval"] == {"k": 7}
    assert isinstance(manifest["python_version"], str)
    assert manifest["python_version"].count(".") == 2


def test_run_manifest_git_fields_are_dirty_true_when_status_has_output(tmp_path, monkeypatch):
    def stub(*args, **kwargs):
        argv = args[0]
        if argv[:2] == ["git", "rev-parse"]:
            return subprocess.CompletedProcess(argv, 0, stdout="b" * 40 + "\n", stderr="")
        return subprocess.CompletedProcess(argv, 0, stdout=" M evals/run.py\n", stderr="")

    monkeypatch.setattr("evals.run.subprocess.run", stub)
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    http_client = httpx.Client(transport=httpx.MockTransport(handler))

    out_path = run(
        dataset=dataset,
        mode="retrieval",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert data["run_manifest"]["git"] == {"commit_sha": "b" * 40, "dirty": True}


def test_run_manifest_git_fields_null_on_subprocess_failure(tmp_path, monkeypatch):
    def stub(*args, **kwargs):
        raise FileNotFoundError("git not found")

    monkeypatch.setattr("evals.run.subprocess.run", stub)
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    http_client = httpx.Client(transport=httpx.MockTransport(handler))

    out_path = run(
        dataset=dataset,
        mode="retrieval",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert data["run_manifest"]["git"] == {"commit_sha": None, "dirty": None}


def test_run_manifest_embedding_model_null_when_env_unset(tmp_path, monkeypatch):
    monkeypatch.delenv("OLLAMA_EMBED_MODEL", raising=False)
    monkeypatch.setattr("evals.run.subprocess.run", _stub_git_success)
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    http_client = httpx.Client(transport=httpx.MockTransport(handler))

    out_path = run(
        dataset=dataset,
        mode="retrieval",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert data["run_manifest"]["embedding_model"] is None


def test_run_permissive_true_skips_bad_rows_instead_of_raising(tmp_path, monkeypatch):
    monkeypatch.setattr("evals.run.subprocess.run", _stub_git_success)
    rows = [
        {
            "id": "q1",
            "lang": "de",
            "question": "Frage eins",
            "expected_sources": [],
            "expected_keywords": [],
            "must_refuse": False,
        },
        {
            "id": "q2",
            "lang": "en",  # invalid lang -> skipped in permissive mode
            "question": "bad row",
            "expected_sources": [],
            "expected_keywords": [],
            "must_refuse": False,
        },
    ]
    dataset = tmp_path / "gold.jsonl"
    dataset.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    out_dir = tmp_path / "results"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [], "took_ms": {"embed": 1}})

    http_client = httpx.Client(transport=httpx.MockTransport(handler))

    out_path = run(
        dataset=dataset,
        mode="retrieval",
        k=5,
        base_url="http://test",
        out_dir=out_dir,
        clock=lambda: 0.0,
        client=http_client,
        permissive=True,
    )

    data = json.loads(out_path.read_text(encoding="utf-8"))
    assert len(data["questions"]) == 1
    assert data["questions"][0]["id"] == "q1"


def test_run_permissive_false_by_default_raises_on_bad_row(tmp_path):
    rows = [
        {
            "id": "q1",
            "lang": "en",
            "question": "bad row",
            "expected_sources": [],
            "expected_keywords": [],
            "must_refuse": False,
        },
    ]
    dataset = tmp_path / "gold.jsonl"
    dataset.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    out_dir = tmp_path / "results"
    http_client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200)))

    with pytest.raises(ValueError):
        run(
            dataset=dataset,
            mode="retrieval",
            k=5,
            base_url="http://test",
            out_dir=out_dir,
            clock=lambda: 0.0,
            client=http_client,
        )


def test_main_permissive_eval_set_flag_is_passed_through_to_run(tmp_path, monkeypatch):
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"
    captured = {}

    def fake_run(dataset, mode, k, base_url, out_dir, permissive=False, **kwargs):
        captured["permissive"] = permissive
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / "eval_stub.json"
        path.write_text("{}", encoding="utf-8")
        return path

    monkeypatch.setattr("evals.run.run", fake_run)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "prog",
            "--retrieval-only",
            "--dataset",
            str(dataset),
            "--out-dir",
            str(out_dir),
            "--permissive-eval-set",
        ],
    )

    main()

    assert captured["permissive"] is True


def test_main_permissive_eval_set_flag_defaults_to_false(tmp_path, monkeypatch):
    dataset = _write_dataset(tmp_path)
    out_dir = tmp_path / "results"
    captured = {}

    def fake_run(dataset, mode, k, base_url, out_dir, permissive=False, **kwargs):
        captured["permissive"] = permissive
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / "eval_stub.json"
        path.write_text("{}", encoding="utf-8")
        return path

    monkeypatch.setattr("evals.run.run", fake_run)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "prog",
            "--retrieval-only",
            "--dataset",
            str(dataset),
            "--out-dir",
            str(out_dir),
        ],
    )

    main()

    assert captured["permissive"] is False
