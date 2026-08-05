import httpx


def embed_query(client: httpx.Client, base_url: str, model: str, text: str) -> list[float]:
    try:
        response = client.post(f"{base_url}/api/embed", json={"model": model, "input": [text]})
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
