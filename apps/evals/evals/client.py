"""Thin HTTP client for the retrieval API's `/search` and `/chat` endpoints."""

from __future__ import annotations

import json
from collections.abc import Iterator

import httpx


def auth_headers(api_key: str | None) -> dict[str, str]:
    """`X-API-Key` header to send, when the retrieval API requires one.

    Empty/`None` `api_key` (the retrieval API's `API_KEY` unset) yields no
    header at all, matching the API's own opt-in-auth behavior.
    """
    return {"X-API-Key": api_key} if api_key else {}


def search(
    client: httpx.Client,
    base_url: str,
    question: str,
    lang: str,
    k: int,
    api_key: str | None = None,
    canton: str | None = None,
) -> list[dict]:
    body: dict = {"q": question, "lang": lang, "k": k}
    if canton is not None:
        body["canton"] = canton
    response = client.post(
        f"{base_url}/search",
        json=body,
        headers=auth_headers(api_key),
    )
    response.raise_for_status()
    return response.json()["results"]


def _iter_sse_events(text: str) -> Iterator[tuple[str, dict]]:
    for block in text.strip().split("\n\n"):
        if not block.strip():
            continue
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        yield lines["event"], json.loads(lines["data"])


def chat(
    client: httpx.Client,
    base_url: str,
    question: str,
    lang: str,
    k: int,
    api_key: str | None = None,
    canton: str | None = None,
) -> tuple[str, list[dict]]:
    body: dict = {"question": question, "lang": lang, "k": k}
    if canton is not None:
        body["canton"] = canton
    response = client.post(
        f"{base_url}/chat",
        json=body,
        headers=auth_headers(api_key),
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"chat request failed with status {response.status_code}: {response.text}"
        )

    parts: list[str] = []
    citations: list[dict] | None = None
    for event, data in _iter_sse_events(response.text):
        if event == "token":
            parts.append(data["delta"])
        elif event == "done":
            citations = data["citations"]
        elif event == "error":
            raise RuntimeError(data.get("detail", "chat stream reported an error"))

    if citations is None:
        raise RuntimeError("chat stream ended without a 'done' event")

    return "".join(parts), citations
