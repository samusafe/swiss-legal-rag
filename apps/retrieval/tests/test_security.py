from retrieval.security import RateLimiter, verify_api_key


def test_disabled_limiter_always_allows() -> None:
    limiter = RateLimiter(0)
    assert all(limiter.allow("1.2.3.4") for _ in range(1000))


def test_allows_up_to_the_limit_then_blocks() -> None:
    clock = {"t": 0.0}
    limiter = RateLimiter(3, clock=lambda: clock["t"])

    results = [limiter.allow("1.2.3.4") for _ in range(4)]

    assert results == [True, True, True, False]


def test_refills_gradually_after_the_window_elapses() -> None:
    clock = {"t": 0.0}
    limiter = RateLimiter(60, clock=lambda: clock["t"])  # 1 token/second

    assert [limiter.allow("1.2.3.4") for _ in range(60)] == [True] * 60
    assert limiter.allow("1.2.3.4") is False  # bucket empty

    clock["t"] += 1.0  # one second later: exactly one token refilled

    assert limiter.allow("1.2.3.4") is True
    assert limiter.allow("1.2.3.4") is False


def test_buckets_are_independent_per_key() -> None:
    clock = {"t": 0.0}
    limiter = RateLimiter(1, clock=lambda: clock["t"])

    assert limiter.allow("1.1.1.1") is True
    assert limiter.allow("1.1.1.1") is False
    assert limiter.allow("2.2.2.2") is True  # unaffected by the first key's bucket


def test_verify_api_key_accepts_matching_key() -> None:
    assert verify_api_key("secret-key", "secret-key") is True


def test_verify_api_key_rejects_wrong_key() -> None:
    assert verify_api_key("wrong", "secret-key") is False


def test_verify_api_key_rejects_missing_header_without_raising() -> None:
    assert verify_api_key(None, "secret-key") is False
