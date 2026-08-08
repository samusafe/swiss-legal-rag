from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sentence_transformers import CrossEncoder


class Reranker:
    """CrossEncoder wrapper; heavyweight import is deferred so tests never load torch."""

    def __init__(self, model_name: str, revision: str | None = None) -> None:
        self._model_name = model_name
        self._revision = revision
        self._model: "CrossEncoder | None" = None

    def scores(self, query: str, texts: list[str]) -> list[float]:
        if self._model is None:
            from sentence_transformers import CrossEncoder

            kwargs = {"revision": self._revision} if self._revision else {}
            self._model = CrossEncoder(self._model_name, **kwargs)
        return [float(s) for s in self._model.predict([(query, text) for text in texts])]
