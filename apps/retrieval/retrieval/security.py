import hmac
import time
from collections.abc import Callable


class RateLimiter:
    """In-memory per-key token bucket.

    Single-process only: state lives in this instance's memory, so it does not
    coordinate across multiple uvicorn workers/processes (see README Security).
    """

    def __init__(self, limit_per_minute: int, clock: Callable[[], float] = time.monotonic) -> None:
        self._limit = limit_per_minute
        self._clock = clock
        self._refill_per_second = limit_per_minute / 60.0
        self._tokens: dict[str, float] = {}
        self._updated_at: dict[str, float] = {}

    def allow(self, key: str) -> bool:
        if self._limit <= 0:  # disabled
            return True
        now = self._clock()
        tokens = self._tokens.get(key, float(self._limit))
        last = self._updated_at.get(key, now)
        tokens = min(float(self._limit), tokens + (now - last) * self._refill_per_second)
        self._updated_at[key] = now
        if tokens < 1.0:
            self._tokens[key] = tokens
            return False
        self._tokens[key] = tokens - 1.0
        return True


def verify_api_key(provided: str | None, expected: str) -> bool:
    """Constant-time API key check.

    Uses `hmac.compare_digest` instead of `!=` so a mismatch takes the same
    time regardless of where the strings first differ — a plain `!=` leaks a
    timing signal an attacker could use to recover the key byte by byte.
    `provided` is `None` when the `X-API-Key` header is absent; that is
    treated as a non-match without ever reaching `compare_digest` (which
    requires two strings/bytes, not `None`).
    """
    if provided is None:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))
