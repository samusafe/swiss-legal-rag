import sys
import types

from retrieval.rerank import Reranker


class _FakeCrossEncoder:
    """Records init args instead of loading torch/real weights."""

    last_kwargs: dict = {}

    def __init__(self, model_name: str, **kwargs: object) -> None:
        _FakeCrossEncoder.last_kwargs = {"model_name": model_name, **kwargs}

    def predict(self, pairs: list[tuple[str, str]]) -> list[float]:
        return [1.0 for _ in pairs]


def _install_fake_sentence_transformers(monkeypatch) -> None:
    fake_module = types.ModuleType("sentence_transformers")
    fake_module.CrossEncoder = _FakeCrossEncoder  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "sentence_transformers", fake_module)


def test_scores_passes_revision_to_cross_encoder_when_set(monkeypatch) -> None:
    _install_fake_sentence_transformers(monkeypatch)
    reranker = Reranker("BAAI/bge-reranker-v2-m3", revision="abc1234")

    reranker.scores("query", ["text"])

    assert _FakeCrossEncoder.last_kwargs == {
        "model_name": "BAAI/bge-reranker-v2-m3",
        "revision": "abc1234",
    }


def test_scores_omits_revision_kwarg_when_unset(monkeypatch) -> None:
    _install_fake_sentence_transformers(monkeypatch)
    reranker = Reranker("BAAI/bge-reranker-v2-m3")

    reranker.scores("query", ["text"])

    assert _FakeCrossEncoder.last_kwargs == {"model_name": "BAAI/bge-reranker-v2-m3"}
