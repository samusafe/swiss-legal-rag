from datetime import date

import httpx
import pytest

from ingestion.sparql import (
    ResolvedVersion,
    build_query,
    eli_from_file_url,
    pick_current,
    run_query,
)
from tests.conftest import make_client


def test_build_query_embeds_sr() -> None:
    query = build_query("235.1")
    assert '"235.1"' in query
    assert "jolux:Consolidation" in query


def test_run_query_parses_rows(sparql_client: httpx.Client) -> None:
    rows = run_query(sparql_client, "220")
    assert len(rows) == 4
    assert rows[0] == ResolvedVersion(
        lang="de",
        version_date=date(2026, 10, 1),
        file_url=(
            "https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch"
            "/eli/cc/27/317_321_377/20261001/de/xml/a-de.xml"
        ),
    )


def test_run_query_raises_on_http_error() -> None:
    client = make_client(lambda request: httpx.Response(503))
    with pytest.raises(RuntimeError, match="220"):
        run_query(client, "220")


def test_pick_current_skips_future_versions(sparql_client: httpx.Client) -> None:
    rows = run_query(sparql_client, "220")
    current = pick_current(rows, ["de", "fr", "it"], today=date(2026, 8, 5))
    assert current["de"].version_date == date(2026, 1, 1)  # not the future 2026-10-01
    assert set(current) == {"de", "fr", "it"}


def test_pick_current_raises_on_missing_language(sparql_client: httpx.Client) -> None:
    rows = run_query(sparql_client, "220")
    with pytest.raises(RuntimeError, match="rm"):
        pick_current(rows, ["de", "rm"], today=date(2026, 8, 5))


def test_eli_from_file_url() -> None:
    url = (
        "https://fedlex.data.admin.ch/filestore/fedlex.data.admin.ch"
        "/eli/cc/27/317_321_377/20260101/de/xml/a-de.xml"
    )
    assert (
        eli_from_file_url(url, "de")
        == "https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de"
    )
