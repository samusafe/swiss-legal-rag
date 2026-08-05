def rrf(rankings: list[list[int]], k: int = 60) -> list[int]:
    """Reciprocal rank fusion: score(id) = sum over rankings of 1/(k + rank + 1)."""
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank + 1)
    return sorted(scores, key=lambda item: (-scores[item], item))
