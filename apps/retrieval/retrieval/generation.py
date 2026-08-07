import json
from collections.abc import Iterator

import httpx

from retrieval.models import SearchResult

# The citation contract lives here: every claim must carry [SR <nr> Art. <x>] and
# un-cited claims are defects the M6 evals count (spec §5).
SYSTEM_PROMPT = """You are a legal information assistant for Swiss federal law.
Answer using ONLY the articles provided in the user message.
Every claim must cite its source inline as [SR <nr> Art. <x>], for example [SR 220 Art. 335c].
Answer in {language}.
If the provided articles do not answer the question, say that you cannot answer from the \
provided articles (in {language}) and do not cite anything.
You provide legal information, not legal advice."""

_LANGUAGE_NAMES = {"de": "German", "fr": "French", "it": "Italian"}


def build_messages(
    question: str, lang: str, sources: list[SearchResult]
) -> list[dict[str, str]]:
    blocks: list[str] = []
    for source in sources:
        label = f"[SR {source.sr} Art. {source.article}]"
        if source.context:
            label = f"{label} {source.context}"
        blocks.append(f"{label}\n{source.text}")
    user = "Articles:\n\n" + "\n\n".join(blocks) + f"\n\nQuestion: {question}"
    system = SYSTEM_PROMPT.format(language=_LANGUAGE_NAMES[lang])
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def stream_chat(
    client: httpx.Client, base_url: str, model: str, messages: list[dict[str, str]]
) -> Iterator[str]:
    # timeout=None: CPU generation of a full answer can take minutes; the per-token
    # stream keeps the connection demonstrably alive.
    try:
        with client.stream(
            "POST",
            f"{base_url}/api/chat",
            json={
                "model": model,
                "messages": messages,
                "stream": True,
                "think": False,
                "options": {"num_ctx": 8192},
            },
            timeout=None,
        ) as response:
            if response.status_code != 200:
                raise RuntimeError(
                    f"Ollama chat failed (HTTP {response.status_code}) — is `ollama serve` "
                    f"running at {base_url} and `{model}` pulled?"
                )
            # Ollama 0.32.4 ignores `think: false` (and qwen3's /no_think) for
            # hybrid-reasoning models: content streams the raw reasoning with NO
            # opening <think> tag, then "</think>", then the answer. Drop
            # everything up to and including the first marker. A marker-less
            # stream (thinking properly disabled) is buffered and flushed once at
            # the end — accepted trade-off; remove this filter when Ollama
            # honors `think: false`.
            marker = "</think>"
            thinking = True
            buffer = ""
            for line in response.iter_lines():
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError as error:
                    raise RuntimeError(
                        f"Ollama chat stream returned an unexpected payload at {base_url}: "
                        f"{line[:200]!r}"
                    ) from error
                if not isinstance(payload, dict):
                    raise RuntimeError(
                        f"Ollama chat stream returned an unexpected payload at {base_url}: "
                        f"{line[:200]!r}"
                    )
                if payload.get("error"):
                    raise RuntimeError(
                        f"Ollama chat failed: {payload['error']} (model {model} at {base_url})"
                    )
                if payload.get("done"):
                    break
                try:
                    delta = payload["message"]["content"]
                except (KeyError, TypeError) as error:
                    raise RuntimeError(
                        f"Ollama chat stream returned an unexpected payload at {base_url}: "
                        f"{line[:200]!r}"
                    ) from error
                if not delta:
                    # Ollama itself emits empty deltas while thinking; skip those before
                    # they ever reach the buffering below — they carry nothing to buffer.
                    continue
                if thinking:
                    buffer += delta
                    index = buffer.find(marker)
                    if index == -1:
                        # No marker yet: yield our own empty heartbeat (distinct from the
                        # empty deltas skipped above) so FastAPI gets a suspension point —
                        # a client disconnect (Stop) can then cancel this generator and
                        # close the httpx stream to Ollama mid-thinking, instead of only
                        # being noticed once the marker is found.
                        yield ""
                        continue
                    thinking = False
                    delta = buffer[index + len(marker) :].lstrip("\n")
                    if not delta:
                        continue
                yield delta
            if thinking and buffer:
                # Marker never appeared — the stream was the answer itself.
                yield buffer
    except httpx.HTTPError as error:
        raise RuntimeError(
            f"Ollama unreachable at {base_url} — is `ollama serve` running and "
            f"`{model}` pulled?"
        ) from error
