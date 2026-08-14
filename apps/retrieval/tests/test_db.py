import pytest

from retrieval.db import fts_search


def test_fts_search_rejects_unsupported_lang() -> None:
    # Guard must raise before touching the connection — pass a fake/None conn.
    with pytest.raises(ValueError, match="unsupported lang"):
        fts_search(None, "frage", "en", 5, ["CH"])
