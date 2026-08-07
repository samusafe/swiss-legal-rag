"""Thin HTTP client for the retrieval API's `/search` and `/chat` endpoints."""

from __future__ import annotations

import json
from collections.abc import Iterator

import httpx


def search(
    client: httpx.Client, base_url: str, question: str, lang: str, k: int
) -> list[dict]:
    response = client.post(
        f"{base_url}/search", json={"q": question, "lang": lang, "k": k}
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
    client: httpx.Client, base_url: str, question: str, lang: str, k: int
) -> tuple[str, list[dict]]:
    response = client.post(
        f"{base_url}/chat", json={"question": question, "lang": lang, "k": k}
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
