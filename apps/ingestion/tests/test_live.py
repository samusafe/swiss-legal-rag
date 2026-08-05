"""Live smoke test against the real Fedlex endpoint. Run: pytest -m live"""
from datetime import date

import httpx
import pytest

from ingestion.sparql import pick_current, run_query


@pytest.mark.live
def test_sr_220_resolves_in_three_languages() -> None:
    with httpx.Client(timeout=60.0) as client:
        rows = run_query(client, "220")
    current = pick_current(rows, ["de", "fr", "it"], today=date.today())
    assert set(current) == {"de", "fr", "it"}
    for version in current.values():
        assert version.file_url.endswith(".xml")
