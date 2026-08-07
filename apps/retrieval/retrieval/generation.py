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


def build_messages(
    question: str, language: str, sources: list[SearchResult]
) -> list[dict[str, str]]:
    """`language` is the English name to answer in (e.g. "German") — see
    `retrieval.language.answer_language`."""
    blocks: list[str] = []
    for source in sources:
        label = f"[SR {source.sr} Art. {source.article}]"
        if source.context:
            label = f"{label} {source.context}"
        blocks.append(f"{label}\n{source.text}")
    user = "Articles:\n\n" + "\n\n".join(blocks) + f"\n\nQuestion: {question}"
    system = SYSTEM_PROMPT.format(language=language)
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


_THINK_OPEN = "<think>"
_THINK_CLOSE = "</think>"


def stream_chat(
    client: httpx.Client, base_url: str, model: str, messages: list[dict[str, str]]
) -> Iterator[tuple[str, str]]:
    """Yields `("thinking" | "token", delta)` pairs.

    Ollama 0.32.4 ignores `think: false` (and qwen3's /no_think) for
    hybrid-reasoning models: content streams the raw reasoning with NO opening
    <think> tag, then "</think>", then the answer. Two cases follow from that:

    1. The stream opens with a literal "<think>" tag — we know for certain it's
       reasoning, so content is forwarded live as "thinking" deltas (holding
       back only a marker-length-1 suffix, in case "</think>" lands split
       across two network chunks). This is what replaces the old empty-delta
       heartbeats and is what makes the reasoning visible while it streams.
    2. No opening tag (the Ollama quirk above, or thinking genuinely disabled)
       — ambiguous until "</think>" turns up or the stream ends, so content is
       buffered silently (empty "token" heartbeats keep the connection
       cancellable) and only classified once resolved: a single "thinking"
       event if the marker appears, or the whole buffer flushed as one "token"
       event if it never does — same trade-off as before.
    """
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
            thinking = True
            confirmed = False  # saw a literal "<think>" tag: safe to stream live
            checked_open = False
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
                if not thinking:
                    yield ("token", delta)
                    continue
                buffer += delta
                if not checked_open:
                    checked_open = True
                    if buffer.startswith(_THINK_OPEN):
                        confirmed = True
                        buffer = buffer[len(_THINK_OPEN) :]
                index = buffer.find(_THINK_CLOSE)
                if index == -1:
                    if confirmed:
                        # Hold back a suffix that could be the start of a split
                        # "</think>"; emit the rest immediately. Always yield at
                        # least one event per chunk (empty heartbeat when
                        # nothing is releasable yet) so the stream stays
                        # cancellable even under a run of small deltas.
                        safe_len = max(0, len(buffer) - (len(_THINK_CLOSE) - 1))
                        yield ("thinking", buffer[:safe_len])
                        buffer = buffer[safe_len:]
                    else:
                        # Ambiguous — could still turn out to be a marker-less
                        # answer. Buffer silently; heartbeat keeps it cancellable.
                        yield ("token", "")
                    continue
                thinking = False
                head = buffer[:index]
                if head:
                    yield ("thinking", head)
                tail = buffer[index + len(_THINK_CLOSE) :].lstrip("\n")
                buffer = ""
                if tail:
                    yield ("token", tail)
            if thinking and buffer:
                if confirmed:
                    # A confirmed "<think>" block never closed before the
                    # stream ended — the withheld tail is still reasoning and
                    # must never leak into the answer as a "token" (it would
                    # pollute citation extraction).
                    yield ("thinking", buffer)
                else:
                    # Marker never appeared — the stream was the answer itself.
                    yield ("token", buffer)
    except httpx.HTTPError as error:
        raise RuntimeError(
            f"Ollama unreachable at {base_url} — is `ollama serve` running and "
            f"`{model}` pulled?"
        ) from error
