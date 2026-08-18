import httpx


def embed_query(client: httpx.Client, base_url: str, model: str, text: str) -> list[float]:
    try:
        # keep_alive: keep the embedding model resident between searches
        # (Ollama default 5m) — reloading it adds seconds to every query.
        response = client.post(
            f"{base_url}/api/embed",
            json={"model": model, "input": [text], "keep_alive": "30m"},
        )
    except httpx.HTTPError as error:
        raise RuntimeError(
            f"Ollama unreachable at {base_url} — is `ollama serve` running and "
            f"`{model}` pulled?"
        ) from error
    if response.status_code != 200:
        raise RuntimeError(
            f"Ollama embed failed (HTTP {response.status_code}) — is `ollama serve` "
            f"running at {base_url} and `{model}` pulled?"
        )
    return response.json()["embeddings"][0]
