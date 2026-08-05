from retrieval.fusion import rrf


def test_rrf_rewards_presence_in_both_rankings() -> None:
    assert rrf([[1, 2, 3], [2, 4]])[0] == 2


def test_rrf_single_ranking_preserves_order() -> None:
    assert rrf([[7, 5, 9]]) == [7, 5, 9]


def test_rrf_ties_break_deterministically_by_id() -> None:
    assert rrf([[3], [1]]) == [1, 3]  # equal scores -> ascending id


def test_rrf_empty() -> None:
    assert rrf([[], []]) == []
